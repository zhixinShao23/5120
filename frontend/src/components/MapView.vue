<script setup>
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch, nextTick } from 'vue'
import L from 'leaflet'
import AppIcon from './AppIcon.vue'
import { scoreBand, flowBand } from '@/services/routing.js'
import { SENSOR_RADIUS_M } from '@/services/engine/grid.js'
import { theme } from '../theme.js'

const props = defineProps({
  sensors: { type: Array, default: () => [] },
  routes: { type: Array, default: () => [] },
  activeRouteId: { type: String, default: null },
  landmarks: { type: Array, default: () => [] },
  refuges: { type: Array, default: () => [] },
  // Refuges near the SELECTED route — a small, contextual subset of
  // `refuges`, always drawn regardless of the "Quiet spots" toggle
  // (showRefuges), since these are specifically relevant to the trip that's
  // actually on screen rather than every refuge in the mapped area.
  nearbyRefuges: { type: Array, default: () => [] },
  origin: { type: Object, default: null },
  destination: { type: Object, default: null },
  showCrowd: { type: Boolean, default: true },
  // True while "Plan ahead" is active — sensors are historical-baseline
  // predictions rather than live/cached readings, on a different flow-band
  // scale (see FLOW_BANDS_PREDICTED) and not a real per-minute count, so the
  // crowd layer colours differently and never shows a raw number.
  predicted: { type: Boolean, default: false },
  showLandmarks: { type: Boolean, default: false },
  showRefuges: { type: Boolean, default: false },
  focus: { type: Object, default: null },
  panelOpen: { type: Boolean, default: false },
  pickMode: { type: String, default: null },
})

const emit = defineEmits(['select-route', 'select-landmark', 'map-ready', 'pick-location', 'cancel-pick'])

const MELBOURNE_CBD = [-37.8136, 144.9631]

const container = ref(null)
const basemap = ref('map')
const locating = ref(false)
const usingFallback = ref(false)

// Leaflet objects are deliberately not reactive — Vue proxying them breaks
// internal identity checks and tanks performance on every pan.
const map = shallowRef(null)
const layers = shallowRef({})
const tileLayer = shallowRef(null)

const TILES = {
  map: {
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  },
  mapDark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  },
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
}

/**
 * Some networks and most ad blockers block `cartocdn.com`, which leaves the
 * map blank with no explanation. Fall back to the OpenStreetMap tile server,
 * which is on nobody's blocklist. OSM only publishes a light basemap, so
 * dark mode keeps this fallback light too rather than going tile-less.
 */
const TILE_FALLBACK = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; OpenStreetMap contributors',
}

/** Which CARTO config the "map" basemap should use right now. */
function mapTileConfig() {
  return theme.value === 'dark' ? TILES.mapDark : TILES.map
}

// Dark Matter is deliberately very dark with muted roads/labels — brighten
// it a touch via CSS filter rather than switching providers, so streets and
// their names stay legible. Only applies to the "map" basemap; satellite
// imagery doesn't need or want this.
const brightenTiles = computed(() => theme.value === 'dark' && basemap.value === 'map')

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

onMounted(() => {
  const instance = L.map(container.value, {
    center: MELBOURNE_CBD,
    // One notch closer than 15 — CARTO's style renders street labels
    // bigger/bolder at this zoom, so it's the cheapest way to make them
    // more legible without touching the raster tiles themselves.
    zoom: 16,
    zoomControl: false,
    attributionControl: true,
    // Keep the interaction feel close to the reference.
    zoomSnap: 0.5,
    wheelPxPerZoomLevel: 120,
  })

  instance.attributionControl.setPrefix('')

  tileLayer.value = L.tileLayer(mapTileConfig().url, {
    attribution: mapTileConfig().attribution,
    maxZoom: 19,
    detectRetina: true,
  }).addTo(instance)

  // If several tiles in a row fail, the whole host is unreachable — swap
  // providers once rather than showing an empty grey rectangle.
  let tileErrors = 0
  tileLayer.value.on('tileerror', () => {
    if (basemap.value !== 'map' || usingFallback.value) return
    if (++tileErrors < 4) return
    usingFallback.value = true
    tileLayer.value.setUrl(TILE_FALLBACK.url)
    instance.attributionControl.addAttribution(TILE_FALLBACK.attribution)
  })

  layers.value = {
    crowd: L.layerGroup().addTo(instance),
    routes: L.layerGroup().addTo(instance),
    landmarks: L.layerGroup().addTo(instance),
    refuges: L.layerGroup().addTo(instance),
    nearbyRefuges: L.layerGroup().addTo(instance),
    endpoints: L.layerGroup().addTo(instance),
  }

  instance.on('click', onMapClick)
  window.addEventListener('keydown', onKeydown)

  map.value = instance
  emit('map-ready', instance)

  drawCrowd()
  drawLandmarks()
  drawRefuges()
  drawNearbyRefuges()
  drawRoutes()
  drawEndpoints()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  map.value?.remove()
  map.value = null
})

// --- Tap-to-pick origin/destination ----------------------------------------

function onMapClick(e) {
  if (!props.pickMode) return
  emit('pick-location', { lat: e.latlng.lat, lng: e.latlng.lng })
}

function onKeydown(e) {
  if (e.key === 'Escape' && props.pickMode) emit('cancel-pick')
}

// --- Crowd layer (feature 1) ----------------------------------------------

function drawCrowd() {
  const layer = layers.value.crowd
  if (!layer) return
  layer.clearLayers()
  if (!props.showCrowd) return

  for (const sensor of props.sensors) {
    const band = flowBand(sensor.count, props.predicted)
    const colour = band.colour

    // The halo's radius IS the router's real matching radius (see
    // engine/grid.js's SENSOR_RADIUS_M). Drawing anything wider would
    // visually overlap route lines the sensor never actually influenced,
    // wrongly implying "this route passes through that reading" when the
    // scoring never matched it to any block on the path.
    L.circle([sensor.lat, sensor.lng], {
      radius: SENSOR_RADIUS_M,
      color: colour,
      weight: 0,
      fillColor: colour,
      fillOpacity: 0.1 + sensor.normalised * 0.22,
      interactive: false,
    }).addTo(layer)

    const diameter = Math.round(20 + sensor.normalised * 20)
    // A predicted reading is an hourly average, not a real per-minute count
    // (see FLOW_BANDS_PREDICTED) — showing it as a bare number invites
    // reading it the same way as a live count, which it isn't. The colour
    // and size still carry how busy it is; the digit just doesn't belong.
    const marker = L.marker([sensor.lat, sensor.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="crowd-marker" style="width:${diameter}px;height:${diameter}px;background:${colour}">${props.predicted ? '' : sensor.count}</div>`,
        iconSize: [diameter, diameter],
        iconAnchor: [diameter / 2, diameter / 2],
      }),
      keyboard: false,
      title: `${sensor.name} — ${band.label}`,
    }).addTo(layer)

    marker.bindPopup(
      props.predicted
        ? `<div class="map-popup">
             <p class="map-popup__title">${escapeHtml(sensor.name)}</p>
             <p class="map-popup__metric" style="color:${colour}">${band.label}</p>
             <p class="map-popup__meta">Typical flow for this time — historical estimate, not a live count</p>
           </div>`
        : `<div class="map-popup">
             <p class="map-popup__title">${escapeHtml(sensor.name)}</p>
             <p class="map-popup__metric" style="color:${colour}">${sensor.count.toLocaleString()} <span>people/min</span></p>
             <p class="map-popup__meta">${band.label} &middot; ${sensor.trend}</p>
           </div>`,
      { closeButton: false, offset: [0, -diameter / 2] },
    )
  }
}

// --- Landmark layer (feature 3) -------------------------------------------

function drawLandmarks() {
  const layer = layers.value.landmarks
  if (!layer) return
  layer.clearLayers()
  if (!props.showLandmarks) return

  for (const landmark of props.landmarks) {
    const band = scoreBand(landmark.sensoryScore)
    const marker = L.marker([landmark.lat, landmark.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="landmark-marker" style="color:${band.colour}">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="${band.colour}">
                   <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 010-5 2.5 2.5 0 010 5z"/>
                 </svg>
               </div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      title: landmark.name,
    }).addTo(layer)

    marker.bindTooltip(
      `${escapeHtml(landmark.name)} — ${band.label.toLowerCase()}`,
      { direction: 'top', offset: [0, -12] },
    )
    marker.on('click', () => emit('select-landmark', landmark))
  }
}

// --- Refuge layer ("Quiet spots") -------------------------------------------
//
// Sensory-calm points of interest from the council POI dataset (parks,
// churches, hospitals, libraries) — a much larger, unfiltered set than the
// curated landmarks list, so drawn with a plainer marker of its own.

function drawRefuges() {
  const layer = layers.value.refuges
  if (!layer) return
  layer.clearLayers()
  if (!props.showRefuges) return

  for (const refuge of props.refuges) {
    const marker = L.marker([refuge.lat, refuge.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="refuge-marker">
                 <svg width="12" height="12" viewBox="0 0 24 24" fill="#fff">
                   <path d="M17 12h2L12 2 5.5 12h2l-3.5 6h6v4h4v-4h6l-3.5-6z"/>
                 </svg>
               </div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      }),
      title: refuge.name,
    }).addTo(layer)

    marker.bindTooltip(
      `${escapeHtml(refuge.name)} — ${escapeHtml(refuge.category)}`,
      { direction: 'top', offset: [0, -10] },
    )
  }
}

// --- Nearby-refuge layer (route detail) -------------------------------------
//
// Distinct from the layer above: these are the refuges near the CURRENTLY
// SELECTED route (see api.js's nearbyRefuges()), always shown once a route
// is picked regardless of whether the general "Quiet spots" toggle is on —
// picking a route should surface what's useful along it without needing a
// second layer switched on too. Drawn larger, with a halo, so they still
// stand out on top of the plainer city-wide layer if that one's on as well.

function drawNearbyRefuges() {
  const layer = layers.value.nearbyRefuges
  if (!layer) return
  layer.clearLayers()

  for (const refuge of props.nearbyRefuges) {
    L.circle([refuge.lat, refuge.lng], {
      radius: 40,
      color: '#1a73e8',
      weight: 0,
      fillColor: '#1a73e8',
      fillOpacity: 0.15,
      interactive: false,
    }).addTo(layer)

    const marker = L.marker([refuge.lat, refuge.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="refuge-marker refuge-marker--nearby">
                 <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
                   <path d="M17 12h2L12 2 5.5 12h2l-3.5 6h6v4h4v-4h6l-3.5-6z"/>
                 </svg>
               </div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      zIndexOffset: 800,
      title: refuge.name,
    }).addTo(layer)

    marker.bindTooltip(
      `${escapeHtml(refuge.name)} — ${escapeHtml(refuge.category)} · ${refuge.distanceM} m away`,
      { direction: 'top', offset: [0, -13] },
    )
  }
}

// --- Route layer (feature 2) ----------------------------------------------

function drawRoutes() {
  const layer = layers.value.routes
  if (!layer) return
  layer.clearLayers()

  // Inactive first so the selected route always paints on top.
  const ordered = [...props.routes].sort((a, b) =>
    a.id === props.activeRouteId ? 1 : b.id === props.activeRouteId ? -1 : 0,
  )

  for (const route of ordered) {
    const isActive = route.id === props.activeRouteId

    L.polyline(route.coordinates, {
      color: '#fff',
      weight: isActive ? 11 : 8,
      opacity: isActive ? 1 : 0.55,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false,
    }).addTo(layer)

    const line = L.polyline(route.coordinates, {
      color: isActive ? route.accent : '#9aa0a6',
      weight: isActive ? 7 : 5,
      opacity: isActive ? 1 : 0.75,
      lineCap: 'round',
      lineJoin: 'round',
      dashArray: isActive ? null : '1 9',
    }).addTo(layer)

    line.on('click', () => emit('select-route', route.id))
    if (!isActive) line.bindTooltip(`${route.label} · ${route.durationMin} min`, { sticky: true })

    // Flag the crowded pinch points the user is being warned about.
    if (isActive) {
      for (const warning of route.warnings) {
        const point = nearestPointOnRoute(route, warning)
        if (!point) continue
        L.marker(point, {
          icon: L.divIcon({
            className: '',
            html: `<div class="crowd-marker" style="width:18px;height:18px;background:#d93025">!</div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
        })
          .addTo(layer)
          .bindTooltip(warning.message, { direction: 'top', offset: [0, -10] })
      }
    }
  }
}

/**
 * Warnings carry a sensor's node id; find the closest vertex of the drawn
 * line to pin the marker on. Nearest-point rather than exact match, because
 * road-matched geometry no longer passes through our grid coordinates.
 */
function nearestPointOnRoute(route, warning) {
  const sensor = props.sensors.find((s) => s.nodeId === warning.nodeId)
  if (!sensor) return null

  let best = null
  let bestDist = Infinity
  for (const [lat, lng] of route.coordinates) {
    const d = (lat - sensor.lat) ** 2 + (lng - sensor.lng) ** 2
    if (d < bestDist) {
      bestDist = d
      best = [lat, lng]
    }
  }
  // ~120 m in degrees²; a sensor further off than that isn't on this route.
  return bestDist < 1.2e-6 ? best : null
}

// --- Origin / destination pins --------------------------------------------

function drawEndpoints() {
  const layer = layers.value.endpoints
  if (!layer) return
  layer.clearLayers()

  const pin = (place, letter, colour) => {
    if (!place) return
    L.marker([place.lat, place.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="endpoint-marker" style="background:${colour}"><span>${letter}</span></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 28],
      }),
      zIndexOffset: 1000,
      title: place.name,
    })
      .addTo(layer)
      .bindTooltip(place.name, { direction: 'top', offset: [0, -28] })
  }

  pin(props.origin, 'A', '#1a73e8')
  pin(props.destination, 'B', '#d93025')
}

// --- Viewport -------------------------------------------------------------

/** Left padding keeps the route clear of the floating panel. */
function fitPadding() {
  const left = props.panelOpen && window.innerWidth > 900 ? 440 : 60
  return { paddingTopLeft: [left, 120], paddingBottomRight: [60, 80] }
}

function fitToRoutes() {
  const active = props.routes.find((r) => r.id === props.activeRouteId) ?? props.routes[0]
  if (!active || !map.value) return
  map.value.flyToBounds(L.latLngBounds(active.coordinates), {
    ...fitPadding(),
    duration: 0.6,
  })
}

function zoomBy(delta) {
  map.value?.setZoom(map.value.getZoom() + delta)
}

function locateMe() {
  if (!map.value || !navigator.geolocation) return
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      map.value.flyTo([coords.latitude, coords.longitude], 16, { duration: 0.8 })
      locating.value = false
    },
    () => {
      // Denied or unavailable — fall back to the CBD rather than doing nothing.
      map.value.flyTo(MELBOURNE_CBD, 16, { duration: 0.8 })
      locating.value = false
    },
    { timeout: 5000 },
  )
}

function toggleBasemap() {
  basemap.value = basemap.value === 'map' ? 'satellite' : 'map'
  const config =
    basemap.value === 'map'
      ? (usingFallback.value ? TILE_FALLBACK : mapTileConfig())
      : TILES.satellite
  tileLayer.value?.setUrl(config.url)
  map.value?.attributionControl.setPrefix('')
}

// --- Reactions -------------------------------------------------------------

// Swap the CARTO basemap's light/dark variant when the theme toggles — but
// only while it's actually showing (not mid-satellite, not on the
// CDN-blocked fallback, which has no dark variant of its own).
watch(theme, () => {
  if (basemap.value === 'map' && !usingFallback.value) {
    tileLayer.value?.setUrl(mapTileConfig().url)
  }
})

watch(() => props.sensors, drawCrowd, { deep: false })
watch(() => props.showCrowd, drawCrowd)
watch(() => props.predicted, drawCrowd)
watch([() => props.landmarks, () => props.showLandmarks], drawLandmarks)
watch([() => props.refuges, () => props.showRefuges], drawRefuges)
watch(() => props.nearbyRefuges, drawNearbyRefuges)
watch([() => props.routes, () => props.activeRouteId], async () => {
  drawRoutes()
  await nextTick()
})
// Re-fit only when the journey itself changes. The 15-second crowd poll
// replaces the routes array wholesale, and re-fitting on that would drag the
// map out from under anyone who had panned away.
watch(
  () => {
    const route = props.routes[0]
    if (!route) return null
    const [start] = route.coordinates
    const end = route.coordinates[route.coordinates.length - 1]
    return `${start}|${end}`
  },
  (signature) => signature && fitToRoutes(),
)
watch([() => props.origin, () => props.destination], drawEndpoints)

watch(
  () => props.focus,
  (target) => {
    if (!target || !map.value) return
    map.value.flyTo([target.lat, target.lng], target.zoom ?? 17, { duration: 0.7 })
  },
)

// Leaflet needs telling when its container resizes.
watch(
  () => props.panelOpen,
  () => setTimeout(() => map.value?.invalidateSize(), 260),
)

defineExpose({ fitToRoutes })
</script>

<template>
  <div class="map">
    <div
      ref="container"
      class="map__canvas"
      :class="{ 'map__canvas--picking': pickMode, 'map__canvas--bright': brightenTiles }"
      role="application"
      aria-label="Map of Melbourne"
    />

    <div v-if="pickMode" class="map__pick-hint">
      <AppIcon name="place" :size="16" />
      Tap the map to set your {{ pickMode === 'origin' ? 'starting point' : 'destination' }}
      <button class="map__pick-cancel" @click="emit('cancel-pick')">Cancel</button>
    </div>

    <div class="map__controls">
      <button
        class="map__control map__control--round"
        :class="{ 'is-active': locating }"
        title="Show your location"
        @click="locateMe"
      >
        <AppIcon name="locate" :size="20" />
        <span class="sr-only">Show your location</span>
      </button>

      <div class="map__zoom">
        <button class="map__control" title="Zoom in" @click="zoomBy(1)">
          <AppIcon name="plus" :size="20" />
          <span class="sr-only">Zoom in</span>
        </button>
        <span class="map__zoom-divider" />
        <button class="map__control" title="Zoom out" @click="zoomBy(-1)">
          <AppIcon name="minus" :size="20" />
          <span class="sr-only">Zoom out</span>
        </button>
      </div>
    </div>

    <button class="map__layers" :title="`Switch to ${basemap === 'map' ? 'satellite' : 'map'}`" @click="toggleBasemap">
      <span class="map__layers-thumb" :class="`is-${basemap === 'map' ? 'satellite' : 'map'}`" />
      <span class="map__layers-label">
        <AppIcon name="layers" :size="14" />
        Layers
      </span>
    </button>
  </div>
</template>

<style scoped>
.map {
  position: absolute;
  inset: 0;
}

.map__canvas {
  height: 100%;
  width: 100%;
}

.map__canvas--picking {
  cursor: crosshair;
}

/* Dark Matter tiles are deliberately very dark with muted roads/labels —
   lighten and de-saturate the raster imagery a touch so streets and their
   names read clearly, without switching tile providers. */
.map__canvas--bright :deep(.leaflet-tile-pane) {
  filter: brightness(1.45) contrast(0.85) saturate(1.15);
}

.map__pick-hint {
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 700;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  border-radius: 999px;
  background: var(--accent-fill);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
  box-shadow: var(--shadow-chip);
  white-space: nowrap;
}

.map__pick-cancel {
  padding: 4px 10px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 12px;
  font-weight: 500;
}

.map__pick-cancel:hover {
  background: rgba(255, 255, 255, 0.32);
}

.map__controls {
  position: absolute;
  right: 12px;
  bottom: 84px;
  z-index: 500;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.map__control {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: var(--text-muted);
  background: var(--surface);
  transition: color 120ms ease;
}

.map__control:hover {
  color: var(--text);
}

.map__control--round {
  border-radius: 50%;
  box-shadow: var(--shadow-chip);
}

.map__control--round.is-active {
  color: var(--accent);
}

.map__zoom {
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--shadow-chip);
}

.map__zoom-divider {
  height: 1px;
  background: var(--divider);
  margin: 0 8px;
}

.map__layers {
  position: absolute;
  left: 12px;
  bottom: 24px;
  z-index: 500;
  width: 64px;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: var(--shadow-chip);
  background: var(--surface);
}

.map__layers-thumb {
  display: block;
  height: 48px;
  background-size: cover;
  background-position: center;
}

.map__layers-thumb.is-satellite {
  background-image: linear-gradient(135deg, #4a5d3a 0%, #6b7a52 40%, #3d5a6c 100%);
}

.map__layers-thumb.is-map {
  background-image: linear-gradient(135deg, #e8eaed 0%, #f5f1e8 50%, #d7e6c8 100%);
}

:root[data-theme='dark'] .map__layers-thumb.is-map {
  background-image: linear-gradient(135deg, #2a2b2d 0%, #232426 50%, #1e2a22 100%);
}

.map__layers-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px 0;
  font-size: 10px;
  font-weight: 500;
  color: var(--text);
}

@media (max-width: 900px) {
  .map__controls {
    bottom: 160px;
  }

  .map__layers {
    bottom: 100px;
  }
}
</style>

<style>
/* Popup internals live in a global block — Leaflet renders them outside the
   component's scoped-style boundary. */
.map-popup {
  padding: 12px 14px;
  min-width: 170px;
}

.map-popup__title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.map-popup__metric {
  margin: 0;
  font-size: 20px;
  font-weight: 500;
  line-height: 1.1;
}

.map-popup__metric span {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
}

.map-popup__meta {
  margin: 4px 0 0;
  font-size: 11px;
  color: var(--text-muted);
  text-transform: capitalize;
}
</style>

<script setup>
import { onMounted, onBeforeUnmount, ref, shallowRef, watch, nextTick } from 'vue'
import L from 'leaflet'
import AppIcon from './AppIcon.vue'
import { scoreBand } from '@/services/routing.js'

const props = defineProps({
  sensors: { type: Array, default: () => [] },
  routes: { type: Array, default: () => [] },
  activeRouteId: { type: String, default: null },
  landmarks: { type: Array, default: () => [] },
  origin: { type: Object, default: null },
  destination: { type: Object, default: null },
  showCrowd: { type: Boolean, default: true },
  showLandmarks: { type: Boolean, default: false },
  focus: { type: Object, default: null },
  panelOpen: { type: Boolean, default: false },
})

const emit = defineEmits(['select-route', 'select-landmark', 'map-ready'])

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
  satellite: {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
  },
}

/**
 * Some networks and most ad blockers block `cartocdn.com`, which leaves the
 * map blank with no explanation. Fall back to the OpenStreetMap tile server,
 * which is on nobody's blocklist.
 */
const TILE_FALLBACK = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '&copy; OpenStreetMap contributors',
}

const LEVEL_COLOURS = {
  low: '#12805c',
  moderate: '#f9ab00',
  high: '#e8710a',
  severe: '#d93025',
}

const LEVEL_LABELS = {
  low: 'Quiet',
  moderate: 'Moderate',
  high: 'Busy',
  severe: 'Very busy',
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

onMounted(() => {
  const instance = L.map(container.value, {
    center: MELBOURNE_CBD,
    zoom: 15,
    zoomControl: false,
    attributionControl: true,
    // Keep the interaction feel close to the reference.
    zoomSnap: 0.5,
    wheelPxPerZoomLevel: 120,
  })

  instance.attributionControl.setPrefix('')

  tileLayer.value = L.tileLayer(TILES.map.url, {
    attribution: TILES.map.attribution,
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
    endpoints: L.layerGroup().addTo(instance),
  }

  map.value = instance
  emit('map-ready', instance)

  drawCrowd()
  drawLandmarks()
  drawRoutes()
  drawEndpoints()
})

onBeforeUnmount(() => {
  map.value?.remove()
  map.value = null
})

// --- Crowd layer (feature 1) ----------------------------------------------

function drawCrowd() {
  const layer = layers.value.crowd
  if (!layer) return
  layer.clearLayers()
  if (!props.showCrowd) return

  for (const sensor of props.sensors) {
    const colour = LEVEL_COLOURS[sensor.level]

    // A soft ground-truth halo sized in metres, so it scales with zoom the
    // way a real catchment would.
    L.circle([sensor.lat, sensor.lng], {
      radius: 70 + sensor.normalised * 190,
      color: colour,
      weight: 0,
      fillColor: colour,
      fillOpacity: 0.1 + sensor.normalised * 0.22,
      interactive: false,
    }).addTo(layer)

    const diameter = Math.round(20 + sensor.normalised * 20)
    const marker = L.marker([sensor.lat, sensor.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div class="crowd-marker" style="width:${diameter}px;height:${diameter}px;background:${colour}">${sensor.count}</div>`,
        iconSize: [diameter, diameter],
        iconAnchor: [diameter / 2, diameter / 2],
      }),
      keyboard: false,
      title: `${sensor.name} — ${LEVEL_LABELS[sensor.level]}`,
    }).addTo(layer)

    marker.bindPopup(
      `<div class="map-popup">
         <p class="map-popup__title">${escapeHtml(sensor.name)}</p>
         <p class="map-popup__metric" style="color:${colour}">${sensor.count.toLocaleString()} <span>people/min</span></p>
         <p class="map-popup__meta">${LEVEL_LABELS[sensor.level]} &middot; ${sensor.trend}</p>
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
      map.value.flyTo(MELBOURNE_CBD, 15, { duration: 0.8 })
      locating.value = false
    },
    { timeout: 5000 },
  )
}

function toggleBasemap() {
  basemap.value = basemap.value === 'map' ? 'satellite' : 'map'
  const config =
    basemap.value === 'map' && usingFallback.value ? TILE_FALLBACK : TILES[basemap.value]
  tileLayer.value?.setUrl(config.url)
  map.value?.attributionControl.setPrefix('')
}

// --- Reactions -------------------------------------------------------------

watch(() => props.sensors, drawCrowd, { deep: false })
watch(() => props.showCrowd, drawCrowd)
watch([() => props.landmarks, () => props.showLandmarks], drawLandmarks)
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
    <div ref="container" class="map__canvas" role="application" aria-label="Map of Melbourne" />

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
  color: #666;
  background: #fff;
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
  background: #e6e6e6;
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
  background: #fff;
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

.map__layers-label {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px 0;
  font-size: 10px;
  font-weight: 500;
  color: #3c4043;
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

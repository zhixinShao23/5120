<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute } from 'vue-router'
import MapView from '../components/MapView.vue'
import SearchBar from '../components/SearchBar.vue'
import DirectionsPanel from '../components/DirectionsPanel.vue'
import LandmarksPanel from '../components/LandmarksPanel.vue'
import LiveStatusCard from '../components/LiveStatusCard.vue'
import CategoryChips from '../components/CategoryChips.vue'
import AlertBanner from '../components/AlertBanner.vue'
import CrowdLegend from '../components/CrowdLegend.vue'
import {
  fetchLiveCrowd,
  fetchWeather,
  fetchLandmarks,
  fetchRefuges,
  planRoute,
  describeTap,
  connection,
} from '../services/api.js'
import { DEFAULT_MAX_FLOW } from '../services/routing.js'

/** How often we re-read the crowd sensors. */
const POLL_INTERVAL_MS = 15000

const route = useRoute()

// --- State -----------------------------------------------------------------

const mode = ref('explore') // 'explore' | 'directions' | 'landmarks'

const origin = ref(null)
const destination = ref(null)
// The user's comfort ceiling: max people per minute anywhere on the route.
const maxFlow = ref(DEFAULT_MAX_FLOW)

const routes = ref([])
const activeRouteId = ref(null)
// Only an explicit click on a route counts as the user's own choice. Auto-
// selection following the recommendation must not be sticky, or changing
// priority would leave the map highlighting yesterday's recommendation.
const userPickedRoute = ref(false)
const planning = ref(false)
// True once a plan has been requested for the current origin/destination —
// gates the results panel between "ready to search" and "here's what we found".
const hasPlanned = ref(false)

const sensors = ref([])
const observedAt = ref(null)
const isLive = ref(false)
const weather = ref(null)
const landmarks = ref([])
const refuges = ref([])

const focus = ref(null)
const alert = ref(null)
// Which field a map tap should fill next: null | 'origin' | 'destination'.
const pickingField = ref(null)

const layers = reactive({
  crowd: true,
  landmarks: false,
  quiet: false,
  transport: false,
  toilets: false,
  shade: false,
})

const searchBar = ref(null)

const panelOpen = computed(() => mode.value !== 'explore')

const visibleLandmarks = computed(() => {
  if (layers.quiet) return landmarks.value.filter((lm) => lm.sensoryScore < 30)
  return landmarks.value
})

const showLandmarkPins = computed(
  () => layers.landmarks || layers.quiet || mode.value === 'landmarks',
)

// --- Data loading ----------------------------------------------------------

let pollTimer = null

async function refreshCrowd() {
  const data = await fetchLiveCrowd()
  sensors.value = data.sensors
  observedAt.value = data.observedAt
  isLive.value = connection.live
}

/** Reconstructs a place object handed off from the homepage's search fields. */
function placeFromQuery(prefix) {
  const id = route.query[`${prefix}Id`]
  const name = route.query[`${prefix}Name`]
  const lat = route.query[`${prefix}Lat`]
  const lng = route.query[`${prefix}Lng`]
  if (!id || !name || lat == null || lng == null) return null
  return { id, name, kind: route.query[`${prefix}Kind`] ?? 'pin', lat: Number(lat), lng: Number(lng) }
}

onMounted(async () => {
  await Promise.all([
    refreshCrowd(),
    fetchWeather().then((w) => (weather.value = w)),
    fetchLandmarks().then((l) => (landmarks.value = l)),
    fetchRefuges().then((r) => (refuges.value = r)),
  ])
  pollTimer = setInterval(refreshCrowd, POLL_INTERVAL_MS)

  const handoffOrigin = placeFromQuery('o')
  const handoffDestination = placeFromQuery('d')
  const handoffMaxFlow = Number(route.query.maxFlow)

  if (handoffOrigin || handoffDestination) {
    // Arrived from the homepage's "Find route" — pick up where it left off.
    origin.value = handoffOrigin
    destination.value = handoffDestination
    if (!Number.isNaN(handoffMaxFlow)) maxFlow.value = handoffMaxFlow
    mode.value = 'directions'
    await nextTick()
    if (handoffOrigin && handoffDestination) replan()
  }
})

onBeforeUnmount(() => clearInterval(pollTimer))

// --- Routing ---------------------------------------------------------------

let planToken = 0

/**
 * `silent` is used by the live re-score on every sensor poll — showing the
 * loading state there would blank the route list every 15 seconds.
 */
async function replan({ silent = false } = {}) {
  // Claim the token before any early return, so clearing an input also
  // invalidates a request still in flight — otherwise its result lands after
  // the user has already moved on and repopulates a list they just emptied.
  const token = ++planToken

  if (!origin.value || !destination.value || origin.value.id === destination.value.id) {
    routes.value = []
    activeRouteId.value = null
    planning.value = false
    return
  }

  hasPlanned.value = true
  if (!silent) planning.value = true

  try {
    const result = await planRoute({
      origin: origin.value,
      destination: destination.value,
      maxFlow: maxFlow.value,
      sensors: sensors.value,
    })

    // A newer request took over while this one was in flight; its own
    // finally block owns the loading state from here.
    if (token !== planToken) return

    routes.value = result

    // A route the user picked by hand survives replans while it exists;
    // otherwise the highlight follows the recommendation.
    const stillThere = result.some((r) => r.id === activeRouteId.value)
    if (!userPickedRoute.value || !stillThere) {
      activeRouteId.value = result.find((r) => r.recommended)?.id ?? result[0]?.id ?? null
    }
  } catch (error) {
    // A planning failure must never leave the panel spinning forever.
    if (token === planToken) routes.value = []
    console.error('Route planning failed', error)
  } finally {
    // Only the newest request clears the spinner, so a slow straggler can't
    // switch it off while a live request is still running.
    if (token === planToken) planning.value = false
  }
}

// A new origin or destination is a new question — clear the old answer and
// wait for an explicit "Find route" instead of planning automatically, so
// picking a point on the map (or search) doesn't fire a plan on every click.
watch(
  [origin, destination],
  () => {
    userPickedRoute.value = false
    hasPlanned.value = false
    routes.value = []
    activeRouteId.value = null
  },
  { deep: true },
)

// The comfort slider re-scores the journey that's already showing, so that
// one still updates live rather than needing another click.
watch(maxFlow, () => {
  if (hasPlanned.value) replan()
})

function findRoute() {
  replan()
}

/**
 * Live re-scoring. When the sensors move we re-plan quietly, and if the
 * recommended route has changed underneath the user, we say so rather than
 * silently swapping the line on the map.
 */
watch(sensors, async () => {
  if (!routes.value.length) return

  const previousId = activeRouteId.value
  const wasUnder = routes.value.find((r) => r.id === previousId)?.underLimit ?? true

  await replan({ silent: true })

  const current = routes.value.find((r) => r.id === previousId)
  const best = routes.value.find((r) => r.recommended)
  if (!current || !best) return

  // The route the user is on has crossed their limit and a within-limit
  // alternative exists — warn, don't silently swap the line on the map.
  if (wasUnder && !current.underLimit && best.id !== current.id && best.underLimit) {
    const slower = best.durationMin - current.durationMin
    alert.value = {
      title: 'Your route just got busier',
      detail: `${current.warnings[0]?.name ?? 'A point on your route'} now peaks at ${
        current.peakFlow
      }/min, over your ${maxFlow.value} limit. An alternative stays under${
        slower > 0 ? ` (+${slower} min)` : ' and is no slower'
      }.`,
      actionLabel: 'Switch route',
      switchTo: best.id,
    }
  }
})

// --- Interactions ----------------------------------------------------------

function openDirections(prefillDestination = null) {
  if (prefillDestination) destination.value = prefillDestination
  mode.value = 'directions'
}

function onSearchSubmit(place) {
  // Searching for somewhere is a statement of intent — go straight to routing.
  destination.value = place
  focus.value = { lat: place.lat, lng: place.lng, zoom: 16 }
  openDirections()
}

function swapEndpoints() {
  const previous = origin.value
  origin.value = destination.value
  destination.value = previous
}

function closePanel() {
  mode.value = 'explore'
  alert.value = null
  pickingField.value = null
}

// --- Tap-to-pick origin/destination -----------------------------------------

function startPicking(field) {
  // Clicking the same field's pin again cancels; clicking the other field's
  // pin switches which one the next tap fills.
  pickingField.value = pickingField.value === field ? null : field
}

function pickLocation({ lat, lng }) {
  const place = describeTap(lat, lng)
  if (pickingField.value === 'origin') origin.value = place
  else if (pickingField.value === 'destination') destination.value = place
  pickingField.value = null
}

function toggleLayer(id) {
  if (id === 'landmarks') {
    // The landmarks chip is the entry point to feature 3, not just a pin layer.
    mode.value = mode.value === 'landmarks' ? 'explore' : 'landmarks'
    layers.landmarks = mode.value === 'landmarks'
    return
  }
  layers[id] = !layers[id]
}

function focusLandmark(landmark) {
  focus.value = { lat: landmark.lat, lng: landmark.lng, zoom: 17 }
}

function routeToLandmark(landmark) {
  destination.value = { id: landmark.id, name: landmark.name, lat: landmark.lat, lng: landmark.lng }
  mode.value = 'directions'
}

function chooseRoute(id) {
  activeRouteId.value = id
  userPickedRoute.value = true
}

function applyAlert() {
  if (alert.value?.switchTo) chooseRoute(alert.value.switchTo)
  alert.value = null
}
</script>

<template>
  <div class="app">
    <MapView
      :sensors="sensors"
      :routes="routes"
      :active-route-id="activeRouteId"
      :landmarks="visibleLandmarks"
      :refuges="refuges"
      :origin="origin"
      :destination="destination"
      :show-crowd="layers.crowd"
      :show-landmarks="showLandmarkPins"
      :show-refuges="layers.quiet"
      :focus="focus"
      :panel-open="panelOpen"
      :pick-mode="pickingField"
      @select-route="chooseRoute"
      @select-landmark="focusLandmark"
      @pick-location="pickLocation"
      @cancel-pick="pickingField = null"
    />

    <!-- Everything below floats over the map; the wrapper must stay
         click-through so panning still works between the panels. -->
    <div class="hud">
      <div class="hud__left">
        <SearchBar
          v-show="mode === 'explore'"
          ref="searchBar"
          v-model="destination"
          @directions="openDirections()"
          @submit="onSearchSubmit"
          @menu="mode = 'landmarks'"
        />

        <LiveStatusCard
          v-if="mode === 'explore'"
          :sensors="sensors"
          :weather="weather"
          :observed-at="observedAt"
          :live="isLive"
          @open-detail="layers.crowd = true"
        />

        <DirectionsPanel
          v-if="mode === 'directions'"
          v-model:origin="origin"
          v-model:destination="destination"
          v-model:max-flow="maxFlow"
          :routes="routes"
          :active-route-id="activeRouteId"
          :loading="planning"
          :weather="weather"
          :picking-field="pickingField"
          :has-planned="hasPlanned"
          @select-route="chooseRoute"
          @swap="swapEndpoints"
          @close="closePanel"
          @pick-on-map="startPicking"
          @find-route="findRoute"
        />

        <LandmarksPanel
          v-if="mode === 'landmarks'"
          :landmarks="landmarks"
          @close="closePanel"
          @focus-landmark="focusLandmark"
          @route-to="routeToLandmark"
        />
      </div>

      <div class="hud__top">
        <CategoryChips :active="layers" @toggle="toggleLayer" />
      </div>

      <div class="hud__bottom">
        <AlertBanner
          v-if="alert"
          :alert="alert"
          @dismiss="alert = null"
          @action="applyAlert"
        />
      </div>

      <CrowdLegend v-if="layers.crowd" class="hud__legend" />
    </div>
  </div>
</template>

<style scoped>
.app {
  position: relative;
  height: 100%;
  width: 100%;
}

.hud {
  position: absolute;
  inset: 0;
  z-index: 600;
  pointer-events: none;
}

.hud > * {
  pointer-events: auto;
}

.hud__left {
  position: absolute;
  top: 12px;
  left: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: calc(100vw - 24px);
}

.hud__top {
  position: absolute;
  top: 12px;
  left: calc(var(--panel-width) + 28px);
  right: 12px;
  /* Only the chips themselves should capture clicks, not the empty track. */
  pointer-events: none;
}

.hud__top :deep(.chip) {
  pointer-events: auto;
}

.hud__bottom {
  position: absolute;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
}

.hud__legend {
  position: absolute;
  right: 12px;
  top: 64px;
}

@media (max-width: 900px) {
  .hud__left {
    right: 12px;
  }

  .hud__top {
    left: 0;
    right: 0;
    top: auto;
    bottom: 12px;
  }

  .hud__bottom {
    bottom: 68px;
  }

  .hud__legend {
    display: none;
  }

  .hud__left :deep(.directions),
  .hud__left :deep(.landmarks) {
    max-height: calc(100vh - var(--nav-height) - 150px);
  }
}
</style>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import PlaceInput from '../components/PlaceInput.vue'
import AppIcon from '../components/AppIcon.vue'
import { fetchLiveCrowd, fetchWeather, fetchRefuges, connection } from '../services/api.js'
import { haversineM } from '../services/engine/grid.js'
import { WALK_SPEED_MPS } from '../services/routing.js'

const POLL_INTERVAL_MS = 15000

// Same fallback reference point routing.js's findRefuges() uses when there's
// no real position to search from — the middle of the Hoddle Grid.
const CBD_CENTER = { lat: -37.8136, lng: 144.9631 }

const SENSITIVITY_OPTIONS = [
  { id: 'low', label: 'Low', maxFlow: 150 },
  { id: 'medium', label: 'Medium', maxFlow: 100 },
  { id: 'high', label: 'High', maxFlow: 50 },
]

const router = useRouter()

const origin = ref(null)
const destination = ref(null)
const sensitivity = ref('low')

const sensors = ref([])
const weather = ref(null)
const refuges = ref([])
const isLive = ref(false)

let pollTimer = null

async function refreshCrowd() {
  const data = await fetchLiveCrowd()
  sensors.value = data.sensors
  isLive.value = connection.live
}

onMounted(async () => {
  await Promise.all([
    refreshCrowd(),
    fetchWeather().then((w) => (weather.value = w)),
    fetchRefuges().then((r) => (refuges.value = r)),
  ])
  pollTimer = setInterval(refreshCrowd, POLL_INTERVAL_MS)
})

onBeforeUnmount(() => clearInterval(pollTimer))

// --- Greeting ----------------------------------------------------------

const greeting = computed(() => {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  return 'Good evening'
})

// --- Status pill + alerts, derived from the same live data the map uses ---

const busySensors = computed(() => sensors.value.filter((s) => s.level === 'busy' || s.level === 'packed'))

const weatherAlert = computed(() => {
  if (!weather.value) return null
  if (weather.value.rainChance > 0.5) return 'Rain likely — shelters get crowded'
  if (weather.value.temperatureC > 28) return `${Math.round(weather.value.temperatureC)}°C on open plazas`
  if (weather.value.windKph > 35) return 'Windy — open plazas will be loud'
  return null
})

const alerts = computed(() => {
  const list = busySensors.value
    .slice(0, 2)
    .map((s) => ({ icon: 'people', text: `High crowd · ${s.name}` }))
  if (weatherAlert.value) list.push({ icon: 'sun', text: weatherAlert.value })
  return list.slice(0, 3)
})

const statusPill = computed(() => {
  if (!sensors.value.length) return { tone: 'calm', text: 'Loading conditions…' }
  const tone = busySensors.value.length > 0 ? 'busy' : 'calm'
  const headline = tone === 'calm' ? 'Mostly calm' : `Busy at ${busySensors.value.length} ${busySensors.value.length === 1 ? 'spot' : 'spots'}`
  const alertNote = alerts.value.length ? ` · ${alerts.value.length} ${alerts.value.length === 1 ? 'alert' : 'alerts'} nearby` : ''
  return { tone, text: `${headline}${alertNote}` }
})

// --- Nearest refuge --------------------------------------------------------

const nearestRefuge = computed(() => {
  if (!refuges.value.length) return null
  let best = null
  let bestDist = Infinity
  for (const r of refuges.value) {
    const d = haversineM(CBD_CENTER.lat, CBD_CENTER.lng, r.lat, r.lng)
    if (d < bestDist) { bestDist = d; best = r }
  }
  if (!best) return null
  return { ...best, minutes: Math.max(1, Math.round(bestDist / WALK_SPEED_MPS / 60)) }
})

// --- Find route --------------------------------------------------------

function placeToQuery(prefix, place) {
  if (!place) return {}
  return {
    [`${prefix}Id`]: place.id,
    [`${prefix}Name`]: place.name,
    [`${prefix}Lat`]: String(place.lat),
    [`${prefix}Lng`]: String(place.lng),
    [`${prefix}Kind`]: place.kind ?? 'pin',
  }
}

const canFindRoute = computed(() => Boolean(origin.value && destination.value))

function findRoute() {
  const maxFlow = SENSITIVITY_OPTIONS.find((o) => o.id === sensitivity.value)?.maxFlow ?? 100
  router.push({
    name: 'map',
    query: {
      ...placeToQuery('o', origin.value),
      ...placeToQuery('d', destination.value),
      maxFlow: String(maxFlow),
    },
  })
}
</script>

<template>
  <div class="home">
    <header class="home__header">
      <div>
        <h1 class="home__greeting">{{ greeting }}</h1>
        <p class="home__subtitle">Here's how the CBD is feeling right now</p>
      </div>
      <span class="home__pill" :class="`home__pill--${statusPill.tone}`">
        <span class="home__pill-dot" />
        {{ statusPill.text }}
      </span>
    </header>

    <section class="home__planner card">
      <div class="home__fields">
        <div class="home__field">
          <AppIcon name="locate" :size="18" class="home__field-icon" />
          <PlaceInput
            :model-value="origin"
            placeholder="Current location"
            aria-label="Starting point"
            @update:model-value="origin = $event"
          />
        </div>
        <div class="home__field">
          <AppIcon name="place" :size="18" class="home__field-icon" />
          <PlaceInput
            :model-value="destination"
            placeholder="Where are you going?"
            aria-label="Destination"
            @update:model-value="destination = $event"
          />
        </div>
        <button class="home__find-btn" :disabled="!canFindRoute" @click="findRoute">
          Find route
          <AppIcon name="chevron" :size="18" />
        </button>
      </div>

      <div class="home__sensitivity">
        <span class="home__sensitivity-label">Sensitivity</span>
        <button
          v-for="option in SENSITIVITY_OPTIONS"
          :key="option.id"
          class="home__sensitivity-btn"
          :class="{ 'is-active': sensitivity === option.id }"
          @click="sensitivity = option.id"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <div class="home__widgets-header">
      <h2 class="home__widgets-title">Your widgets</h2>
    </div>

    <section class="home__widgets">
      <RouterLink to="/map" class="widget card widget--map">
        <div class="widget__head">
          <h3 class="widget__title">Live map</h3>
          <span class="widget__link">View map <AppIcon name="chevron" :size="14" /></span>
        </div>
        <div class="widget__map" aria-hidden="true">
          <svg viewBox="0 0 260 140" preserveAspectRatio="none">
            <rect width="260" height="140" fill="var(--surface-sunken)" />
            <g stroke="var(--surface)" stroke-width="3">
              <line x1="0" y1="35" x2="260" y2="35" />
              <line x1="0" y1="75" x2="260" y2="75" />
              <line x1="0" y1="110" x2="260" y2="110" />
              <line x1="60" y1="0" x2="60" y2="140" />
              <line x1="130" y1="0" x2="130" y2="140" />
              <line x1="200" y1="0" x2="200" y2="140" />
            </g>
            <rect x="8" y="8" width="30" height="22" rx="4" fill="var(--calm)" opacity="0.55" />
            <rect x="216" y="8" width="30" height="20" rx="4" fill="var(--calm)" opacity="0.55" />
            <rect x="8" y="112" width="26" height="20" rx="4" fill="var(--calm)" opacity="0.4" />
            <circle cx="112" cy="88" r="20" fill="var(--overwhelming)" opacity="0.28" />
            <circle cx="112" cy="88" r="8" fill="var(--overwhelming)" />
            <circle cx="168" cy="98" r="7" fill="var(--calm)" opacity="0.7" />
          </svg>
        </div>
      </RouterLink>

      <div class="widget card">
        <div class="widget__head">
          <h3 class="widget__title">Alerts</h3>
          <span class="widget__count">{{ alerts.length }} active</span>
        </div>
        <ul v-if="alerts.length" class="widget__alerts">
          <li v-for="(item, index) in alerts" :key="index">
            <AppIcon :name="item.icon" :size="16" />
            {{ item.text }}
          </li>
        </ul>
        <p v-else class="widget__empty">No active alerts — conditions are calm.</p>
      </div>

      <div class="widget card">
        <div class="widget__head">
          <h3 class="widget__title">Nearest refuge</h3>
        </div>
        <div v-if="nearestRefuge" class="widget__refuge">
          <span class="widget__refuge-icon"><AppIcon name="park" :size="18" /></span>
          <span class="widget__refuge-name">{{ nearestRefuge.name }}</span>
        </div>
        <p v-if="nearestRefuge" class="widget__refuge-detail">
          {{ nearestRefuge.minutes }} min walk · {{ nearestRefuge.noiseLevel ?? 'quiet' }} noise
        </p>
        <p v-else class="widget__empty">Loading nearby refuges…</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.home {
  max-width: 1040px;
  margin: 0 auto;
  padding: 40px 24px 64px;
}

.home__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 24px;
}

.home__greeting {
  margin: 0;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.home__subtitle {
  margin: 6px 0 0;
  font-size: 15px;
  color: var(--text-muted);
}

.home__pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 16px;
  border-radius: var(--radius-pill);
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
}

.home__pill--calm {
  background: var(--calm-soft);
  color: var(--calm);
}

.home__pill--busy {
  background: var(--overwhelming-soft);
  color: var(--overwhelming);
}

.home__pill-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

.home__planner {
  padding: 20px;
  margin-bottom: 32px;
}

.home__fields {
  display: grid;
  /* Capped, not 1fr — on a wide screen 1fr let each field grow past 390px,
     which looks like an empty, stretched box around one line of
     placeholder text. Leftover width beyond the cap is left as trailing
     space in the row instead of inflating the fields. */
  grid-template-columns: minmax(0, 340px) minmax(0, 340px) auto;
  justify-content: start;
  gap: 12px;
}

.home__field {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 48px;
  padding: 0 16px;
  border-radius: var(--radius-card);
  border: 1px solid var(--border);
}

.home__field:focus-within {
  border-color: var(--accent);
}

.home__field-icon {
  color: var(--text-faint);
  flex-shrink: 0;
}

.home__field :deep(.place-input__map-btn) {
  display: none;
}

.home__find-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 48px;
  padding: 0 24px;
  border-radius: var(--radius-card);
  background: var(--strong-fill);
  color: var(--strong-fill-text);
  font-size: 15px;
  font-weight: 500;
  white-space: nowrap;
  transition: background 120ms ease, opacity 120ms ease;
}

.home__find-btn:hover:not(:disabled) {
  background: var(--strong-fill-hover);
}

.home__find-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.home__sensitivity {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 16px;
}

.home__sensitivity-label {
  font-size: 13px;
  color: var(--text-muted);
  margin-right: 4px;
}

.home__sensitivity-btn {
  height: 34px;
  padding: 0 16px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}

.home__sensitivity-btn:hover {
  background: var(--surface-sunken);
}

.home__sensitivity-btn.is-active {
  background: var(--calm-soft);
  border-color: var(--calm);
  color: var(--calm);
}

.home__widgets-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.home__widgets-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.home__widgets {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.widget {
  display: flex;
  flex-direction: column;
  padding: 18px;
  text-decoration: none;
  color: inherit;
}

.widget__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.widget__title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}

.widget__link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 13px;
  color: var(--text-muted);
}

.widget__count {
  font-size: 13px;
  color: var(--text-faint);
}

.widget--map {
  padding: 18px 18px 0;
  overflow: hidden;
}

.widget__map {
  margin: 0 -18px;
  line-height: 0;
}

.widget__map svg {
  width: 100%;
  height: 140px;
  display: block;
}

.widget__alerts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.widget__alerts li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--text);
}

.widget__alerts li :deep(svg) {
  color: var(--text-faint);
  flex-shrink: 0;
}

.widget__empty {
  margin: 0;
  font-size: 13px;
  color: var(--text-faint);
}

.widget__refuge {
  display: flex;
  align-items: center;
  gap: 10px;
}

.widget__refuge-icon {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--calm-soft);
  color: var(--calm);
  flex-shrink: 0;
}

.widget__refuge-name {
  font-size: 14px;
  font-weight: 600;
}

.widget__refuge-detail {
  margin: 8px 0 0;
  font-size: 13px;
  color: var(--text-muted);
}

@media (max-width: 860px) {
  .home__fields {
    grid-template-columns: 1fr;
  }

  .home__widgets {
    grid-template-columns: 1fr;
  }
}
</style>

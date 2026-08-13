<script setup>
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  sensors: { type: Array, default: () => [] },
  weather: { type: Object, default: null },
  // Data recency — a real backend echoes the sensor reading's own timestamp
  // here, which can be genuinely older than "now" for a stale/cached
  // reading. Drives the "· X min ago" text below.
  observedAt: { type: String, default: null },
  // When THIS browser last completed a fetch, regardless of whether the
  // data changed — what the reload button's tooltip actually confirms.
  lastFetchedAt: { type: String, default: null },
  live: { type: Boolean, default: false },
  // Set when the crowd layer is showing a historical prediction ("Monday at
  // 5:00 PM") instead of live/cached sensor readings.
  predictedLabel: { type: String, default: null },
  // True while a manually-triggered refetch is in flight.
  refreshing: { type: Boolean, default: false },
})

const emit = defineEmits(['open-detail', 'refresh'])

/** The headline the card leads with, mirroring the traffic card in Maps. */
const summary = computed(() => {
  const busy = props.sensors.filter((s) => s.level === 'high' || s.level === 'severe')
  if (!props.sensors.length) {
    return { title: 'Loading crowd data', detail: 'Connecting to pedestrian sensors', tone: 'calm' }
  }
  if (busy.length === 0) {
    return {
      title: 'Quiet across the city',
      detail: props.predictedLabel
        ? 'No location is predicted to see heavy foot traffic at that time'
        : 'No sensor is reporting heavy foot traffic right now',
      tone: 'calm',
    }
  }
  const worst = [...busy].sort((a, b) => b.count - a.count)[0]
  // Predicted counts are an hourly average, not a real per-minute reading
  // (see FLOW_BANDS_PREDICTED) — showing the number here would invite
  // reading it the same way as a live count.
  const detail = props.predictedLabel
    ? `Busiest is predicted to be ${worst.name}`
    : `Busiest is ${worst.name} at ${worst.count.toLocaleString()} people/min`
  return {
    title: `Crowding at ${busy.length} ${busy.length === 1 ? 'location' : 'locations'}`,
    detail,
    tone: busy.length > 4 ? 'severe' : 'busy',
  }
})

const TONE_COLOURS = { calm: '#12805c', busy: '#e8710a', severe: '#d93025' }

const updated = computed(() => {
  if (!props.observedAt) return ''
  const seconds = Math.round((Date.now() - new Date(props.observedAt).getTime()) / 1000)
  if (seconds < 45) return 'just now'
  return `${Math.round(seconds / 60)} min ago`
})

/** Exact client fetch time, for the tooltip — confirms a reload actually
 *  happened even when the underlying data (and so `updated` above) didn't
 *  change, which observedAt alone can't. */
const fetchedAtLabel = computed(() => {
  if (!props.lastFetchedAt) return ''
  const d = new Date(props.lastFetchedAt)
  return Number.isNaN(d.getTime()) ? '' : `Last fetched ${d.toLocaleTimeString()}`
})
</script>

<template>
  <div class="status card">
    <div class="status__top">
      <div>
        <p class="status__place">Melbourne CBD</p>
        <p class="status__source" :title="fetchedAtLabel">
          <span class="status__dot" :class="{ 'is-live': live }" />
          <template v-if="predictedLabel">Predicted for {{ predictedLabel }}</template>
          <template v-else>{{ live ? 'Live City of Melbourne data' : 'Simulated data' }} · {{ updated }}</template>
          <button
            v-if="!predictedLabel"
            class="status__refresh"
            :class="{ 'is-spinning': refreshing }"
            type="button"
            title="Refresh crowd data"
            :disabled="refreshing"
            @click.stop="emit('refresh')"
          >
            <AppIcon name="refresh" :size="12" />
            <span class="sr-only">Refresh crowd data</span>
          </button>
        </p>
      </div>
      <div v-if="weather" class="status__weather">
        <span class="status__temp">{{ Math.round(weather.temperatureC) }}°</span>
        <AppIcon name="cloud" :size="24" />
        <span class="sr-only">{{ weather.condition }}</span>
      </div>
    </div>

    <button class="status__row" @click="emit('open-detail')">
      <span class="status__icon" :style="{ background: TONE_COLOURS[summary.tone] }">
        <AppIcon name="people" :size="16" />
      </span>
      <span class="status__body">
        <span class="status__title">{{ summary.title }}</span>
        <span class="status__detail">{{ summary.detail }}</span>
      </span>
      <AppIcon name="chevron" :size="18" class="status__chevron" />
    </button>
  </div>
</template>

<style scoped>
.status {
  width: var(--panel-width);
  max-width: calc(100vw - 24px);
  padding: 12px 8px 6px 16px;
}

.status__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding-right: 8px;
}

.status__place {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.status__source {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 3px 0 0;
  font-size: 11px;
  color: var(--text-faint);
}

.status__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-faint);
}

.status__dot.is-live {
  background: var(--calm);
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}

.status__refresh {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: var(--text-faint);
  flex-shrink: 0;
}

.status__refresh:hover:not(:disabled) {
  color: var(--text-muted);
  background: var(--hover-strong);
}

.status__refresh:disabled {
  cursor: default;
}

.status__refresh.is-spinning svg {
  animation: spin 700ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.status__weather {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}

.status__temp {
  font-size: 16px;
  color: var(--text);
}

.status__row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: calc(100% + 8px);
  margin: 8px -8px 0 -16px;
  padding: 10px 8px 10px 16px;
  border-radius: 0 0 var(--radius-card) var(--radius-card);
  text-align: left;
  transition: background 120ms ease;
}

.status__row:hover {
  background: var(--hover-weak);
}

.status__icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: #fff;
  flex-shrink: 0;
}

.status__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.status__title {
  font-size: 13px;
  font-weight: 500;
}

.status__detail {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status__chevron {
  color: var(--text-faint);
  flex-shrink: 0;
}
</style>

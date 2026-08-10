<script setup>
import { computed, ref, onMounted } from 'vue'
import PlaceInput from './PlaceInput.vue'
import CrowdLimit from './CrowdLimit.vue'
import RouteCard from './RouteCard.vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  origin: { type: Object, default: null },
  destination: { type: Object, default: null },
  maxFlow: { type: Number, required: true },
  routes: { type: Array, default: () => [] },
  activeRouteId: { type: String, default: null },
  loading: { type: Boolean, default: false },
  weather: { type: Object, default: null },
  pickingField: { type: String, default: null },
  hasPlanned: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:origin',
  'update:destination',
  'update:maxFlow',
  'select-route',
  'swap',
  'close',
  'pick-on-map',
  'find-route',
])

const originInput = ref(null)
const destinationInput = ref(null)

const ready = computed(() => Boolean(props.origin && props.destination))

const sameEndpoints = computed(
  () => ready.value && props.origin.id === props.destination.id,
)

/** Weather nudges the score, so say so rather than leaving it unexplained. */
const weatherNote = computed(() => {
  if (!props.weather) return null
  if (props.weather.rainChance > 0.5) return 'Rain likely — shelters get crowded'
  if (props.weather.temperatureC > 30) return 'Hot today — shaded routes preferred'
  if (props.weather.windKph > 35) return 'Windy — open plazas will be loud'
  return null
})

onMounted(() => {
  // Land the cursor wherever the user still has to type.
  if (!props.origin) originInput.value?.focus()
  else if (!props.destination) destinationInput.value?.focus()
})
</script>

<template>
  <section class="directions card" aria-label="Route planner">
    <header class="directions__header">
      <button class="icon-button" title="Back to search" @click="emit('close')">
        <AppIcon name="close" :size="20" />
        <span class="sr-only">Close directions</span>
      </button>
      <h1 class="directions__title">Sensory-friendly directions</h1>
    </header>

    <div class="directions__inputs">
      <div class="directions__timeline" aria-hidden="true">
        <span class="directions__dot directions__dot--origin" />
        <span class="directions__line" />
        <span class="directions__dot directions__dot--destination" />
      </div>

      <div class="directions__fields">
        <div class="directions__field">
          <PlaceInput
            ref="originInput"
            :model-value="origin"
            placeholder="Choose starting point"
            aria-label="Starting point"
            :picking="pickingField === 'origin'"
            @update:model-value="emit('update:origin', $event)"
            @pick-on-map="emit('pick-on-map', 'origin')"
          />
        </div>
        <div class="directions__field">
          <PlaceInput
            ref="destinationInput"
            :model-value="destination"
            placeholder="Choose destination"
            aria-label="Destination"
            :picking="pickingField === 'destination'"
            @update:model-value="emit('update:destination', $event)"
            @pick-on-map="emit('pick-on-map', 'destination')"
          />
        </div>
      </div>

      <button class="icon-button directions__swap" title="Swap start and destination" @click="emit('swap')">
        <AppIcon name="swap" :size="18" />
        <span class="sr-only">Swap start and destination</span>
      </button>
    </div>

    <div class="directions__needs">
      <CrowdLimit
        :model-value="maxFlow"
        @update:model-value="emit('update:maxFlow', $event)"
      />
      <p v-if="weatherNote" class="directions__weather">
        <AppIcon name="info" :size="14" />
        {{ weatherNote }}
      </p>
    </div>

    <div class="directions__results scroll-area">
      <p v-if="sameEndpoints" class="directions__empty">
        Start and destination are the same. Pick somewhere else to go.
      </p>

      <p v-else-if="!ready" class="directions__empty">
        Enter a start and a destination — by search or by tapping the pin
        icon to choose a point on the map — then find your route.
      </p>

      <div v-else-if="!hasPlanned && !loading" class="directions__find">
        <p class="directions__find-hint">
          Ready when you are. Every option is checked against live crowd
          numbers, and we recommend the fastest one that stays under your
          limit.
        </p>
        <button class="directions__find-btn" @click="emit('find-route')">
          <AppIcon name="route" :size="18" />
          Find route
        </button>
      </div>

      <p v-else-if="loading" class="directions__empty">
        <span class="directions__spinner" aria-hidden="true" />
        Scoring routes against live crowd data…
      </p>

      <p v-else-if="!routes.length" class="directions__empty">
        No walking route found between those two points.
      </p>

      <template v-else>
        <p class="directions__count">
          {{ routes.length }} {{ routes.length === 1 ? 'option' : 'options' }} for your limit
        </p>
        <RouteCard
          v-for="route in routes"
          :key="route.id"
          :route="route"
          :max-flow="maxFlow"
          :active="route.id === activeRouteId"
          @select="emit('select-route', $event)"
        />
      </template>
    </div>
  </section>
</template>

<style scoped>
.directions {
  display: flex;
  flex-direction: column;
  width: var(--panel-width);
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - var(--nav-height) - 100px);
  overflow: hidden;
}

.directions__header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 4px 8px;
}

.directions__title {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.directions__inputs {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 12px 12px;
}

.directions__timeline {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  flex-shrink: 0;
}

.directions__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.directions__dot--origin {
  border: 3px solid var(--accent);
}

.directions__dot--destination {
  background: var(--overwhelming);
  border-radius: 50% 50% 50% 0;
  transform: rotate(-45deg);
}

.directions__line {
  flex: 1;
  width: 2px;
  min-height: 22px;
  background: repeating-linear-gradient(
    to bottom,
    var(--border) 0 3px,
    transparent 3px 6px
  );
}

.directions__fields {
  flex: 1;
  min-width: 0;
  display: grid;
  gap: 8px;
}

.directions__field {
  display: flex;
  align-items: center;
  height: 40px;
  padding: 0 12px;
  border-radius: var(--radius-card);
  background: var(--surface-sunken);
  transition: box-shadow 120ms ease;
}

.directions__field:focus-within {
  background: var(--surface);
  box-shadow: 0 0 0 2px var(--accent) inset;
}

.directions__swap {
  flex-shrink: 0;
  color: var(--text-muted);
}

.directions__needs {
  padding: 14px 16px;
  border-top: 1px solid var(--divider);
  background: var(--surface-sunken);
}

.directions__weather {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--moderate);
}

.directions__results {
  flex: 1;
  border-top: 1px solid var(--divider);
  min-height: 0;
}

.directions__count {
  margin: 0;
  padding: 12px 16px 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.directions__empty {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0;
  padding: 24px 20px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
}

.directions__find {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 14px;
  padding: 22px 20px 28px;
}

.directions__find-hint {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
  text-align: center;
}

.directions__find-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 44px;
  border-radius: var(--radius-pill);
  background: var(--accent-fill);
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  transition: background 120ms ease;
}

.directions__find-btn:hover {
  background: var(--accent-fill-hover);
}

.directions__spinner {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 700ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<script setup>
import { computed, ref } from 'vue'
import { flowBand, MAX_FLOW, MAX_FLOW_PREDICTED } from '@/services/routing.js'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  route: { type: Object, required: true },
  maxFlow: { type: Number, required: true },
  active: { type: Boolean, default: false },
})

defineEmits(['select'])

const expanded = ref(false)

const band = computed(() => flowBand(props.route.peakFlow, props.route.predicted))

const distanceLabel = computed(() =>
  props.route.distanceM >= 1000
    ? `${(props.route.distanceM / 1000).toFixed(1)} km`
    : `${props.route.distanceM} m`,
)

// Predicted density never approaches the live feed's scale (see
// FLOW_BANDS_PREDICTED) — without a smaller visual ceiling here, a
// predicted route's bar would sit mostly empty regardless of how busy it
// actually is relative to other predicted hours.
const visualMax = computed(() => (props.route.predicted ? MAX_FLOW_PREDICTED : MAX_FLOW))

/** Bar geometry: peak fill and the tick marking the user's limit. */
const peakPercent = computed(() => Math.min(100, (props.route.peakFlow / visualMax.value) * 100))
const limitPercent = computed(() => Math.min(100, (props.maxFlow / visualMax.value) * 100))
</script>

<template>
  <article
    class="route"
    :class="{ 'is-active': active, 'is-excluded': route.underLimit === false }"
  >
    <button class="route__main" :aria-pressed="active" @click="$emit('select', route.id)">
      <!-- The rail carries the crowd level as pure colour, so the level reads
           before any text does and the label itself can stay small. -->
      <span class="route__rail" :style="{ background: band.colour }" />

      <span class="route__body">
        <template v-if="active">
          <span class="route__head">
            <span class="route__duration">{{ route.durationMin }} min</span>
            <span class="route__distance">{{ distanceLabel }}</span>
            <span v-if="route.recommended" class="route__badge">
              <AppIcon name="check" :size="12" />
              Recommended
            </span>
            <span
              v-if="route.refuges?.length"
              class="route__refuge-badge"
              :title="`${route.refuges.length} quiet ${route.refuges.length === 1 ? 'spot' : 'spots'} on this route`"
            >
              <AppIcon name="park" :size="12" />
              {{ route.refuges.length }}
            </span>
          </span>

          <span class="route__via">via {{ route.via }}</span>

          <span class="route__flow">
            <span
              class="route__flow-bar"
              role="img"
              :aria-label="`Busiest point ${route.peakFlow} people per minute; your limit is ${maxFlow}`"
            >
              <span
                class="route__flow-fill"
                :style="{ width: `${peakPercent}%`, background: band.colour }"
              />
              <span class="route__flow-limit" :style="{ left: `${limitPercent}%` }" />
            </span>
            <span class="route__flow-text" :style="{ color: band.colour }">
              peak {{ route.peakFlow }}/min
            </span>
          </span>

          <span v-if="route.reason" class="route__reason">
            <AppIcon name="info" :size="13" />
            {{ route.reason }}
          </span>

          <span v-else-if="route.excludedBecause" class="route__excluded">
            Not recommended — {{ route.excludedBecause }}
          </span>

          <span v-if="route.warnings.length" class="route__warning">
            <AppIcon name="warning" :size="13" />
            {{ route.warnings.length }}
            {{ route.warnings.length === 1 ? 'point' : 'points' }} over your limit
          </span>
        </template>

        <!-- Not selected yet. Two lines only: how crowded (colour + a modest
             label), then the facts that tell two options apart. `via` earns
             its place here — without it, two routes sharing a band and a
             rounded time render as identical rows. -->
        <template v-else>
          <span class="route__summary">
            <span class="route__band-label" :style="{ color: band.colour }">{{ band.label }}</span>
            <span v-if="route.recommended" class="route__badge">
              <AppIcon name="check" :size="12" />
              Recommended
            </span>
            <span
              v-if="route.refuges?.length"
              class="route__refuge-badge"
              :title="`${route.refuges.length} quiet ${route.refuges.length === 1 ? 'spot' : 'spots'} on this route`"
            >
              <AppIcon name="park" :size="12" />
              {{ route.refuges.length }}
            </span>
          </span>
          <span class="route__meta">
            {{ route.durationMin }} min · {{ distanceLabel }} · via {{ route.via }}
          </span>
        </template>
      </span>
    </button>

    <template v-if="active">
      <button
        class="route__toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ expanded ? 'Hide steps' : 'Turn-by-turn steps' }}
        <AppIcon name="chevron" :size="14" :class="{ 'is-open': expanded }" />
      </button>

      <div v-if="expanded" class="route__details">
        <p class="route__peak-note">
          Busiest point: {{ route.peakAt }} at {{ route.peakFlow }} people/min ·
          typical {{ route.meanFlow }}/min along the way
        </p>

        <ol class="route__steps">
          <li v-for="(step, index) in route.steps" :key="index">
            <AppIcon name="walk" :size="15" />
            <span>
              <strong>{{ step.instruction }}</strong>
              <em>{{ step.detail }} · {{ step.metres }} m</em>
            </span>
          </li>
        </ol>
      </div>
    </template>
  </article>
</template>

<style scoped>
.route {
  border-bottom: 1px solid var(--divider);
}

.route.is-active {
  background: var(--surface-hover);
}

/* Over the user's limit. Still selectable — the user can overrule us — but
   visibly de-emphasised so the recommendation reads as the default. */
.route.is-excluded .route__duration,
.route.is-excluded .route__distance,
.route.is-excluded .route__via,
.route.is-excluded .route__meta {
  color: var(--text-faint);
}

.route__main {
  display: flex;
  gap: 12px;
  width: 100%;
  padding: 14px 16px 12px;
  text-align: left;
}

.route__rail {
  width: 4px;
  border-radius: 2px;
  flex-shrink: 0;
}

.route__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.route__head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.route__duration {
  font-size: 17px;
  font-weight: 500;
}

.route__distance {
  font-size: 13px;
  color: var(--text-muted);
}

.route__badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--calm-soft);
  color: var(--calm);
  font-size: 11px;
  font-weight: 500;
}

.route__refuge-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px;
  border-radius: var(--radius-pill);
  background: var(--surface-sunken);
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.route__via {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.route__flow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}

.route__flow-bar {
  position: relative;
  flex: 1;
  height: 5px;
  border-radius: 3px;
  background: var(--divider);
  overflow: visible;
}

.route__flow-fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  transition: width 260ms ease;
}

/* The user's ceiling, drawn as a tick over the bar. */
.route__flow-limit {
  position: absolute;
  top: -3px;
  bottom: -3px;
  width: 2px;
  margin-left: -1px;
  border-radius: 1px;
  background: var(--text);
  opacity: 0.55;
}

.route__flow-text {
  font-size: 11px;
  font-weight: 500;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* Crowd level leads, but quietly — the coloured rail already carries the
   signal, so the label only has to name it, not shout it. */
.route__summary {
  display: flex;
  align-items: center;
  gap: 8px;
}

.route__band-label {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.route__meta {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.route__warning {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--overwhelming);
}

.route__reason {
  display: inline-flex;
  align-items: flex-start;
  gap: 5px;
  font-size: 11px;
  line-height: 1.45;
  color: var(--calm);
}

.route__reason svg {
  flex-shrink: 0;
  margin-top: 1px;
}

.route__excluded {
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-faint);
}

.route__toggle {
  display: flex;
  align-items: center;
  gap: 3px;
  margin: 0 0 10px 32px;
  font-size: 12px;
  font-weight: 500;
  color: var(--accent);
}

.route__toggle svg {
  transition: transform 160ms ease;
}

.route__toggle svg.is-open {
  transform: rotate(90deg);
}

.route__details {
  padding: 0 16px 16px 32px;
}

.route__peak-note {
  margin: 0 0 14px;
  padding: 10px 12px;
  background: var(--surface-sunken);
  border-radius: var(--radius-card);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-muted);
}

.route__steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 12px;
}

.route__steps li {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  color: var(--text-muted);
}

.route__steps span {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.route__steps strong {
  font-size: 13px;
  font-weight: 400;
  color: var(--text);
}

.route__steps em {
  font-size: 11px;
  font-style: normal;
  color: var(--text-faint);
}
</style>

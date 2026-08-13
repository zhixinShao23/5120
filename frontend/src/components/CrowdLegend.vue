<script setup>
import { computed } from 'vue'
import { FLOW_BANDS, FLOW_BANDS_PREDICTED } from '@/services/routing.js'

const props = defineProps({
  // Predicted markers are coloured off FLOW_BANDS_PREDICTED, a much smaller
  // scale (see that table's own comment) — a legend still showing the live
  // ranges here would flatly contradict the colours on the map.
  predicted: { type: Boolean, default: false },
})

/** Legend for the crowd layer currently on screen. */
const LEVELS = computed(() => {
  const bands = props.predicted ? FLOW_BANDS_PREDICTED : FLOW_BANDS
  return bands.map((band, i) => {
    const floor = i === 0 ? null : bands[i - 1].ceiling
    const range = floor == null ? `< ${band.ceiling}` : band.ceiling === Infinity ? `> ${floor}` : `${floor}–${band.ceiling}`
    return { label: band.label, range, colour: band.colour }
  })
})
</script>

<template>
  <div class="legend card">
    <p class="legend__title">
      {{ predicted ? 'Predicted flow (people/min)' : 'Foot traffic (people/min)' }}
    </p>
    <ul>
      <li v-for="level in LEVELS" :key="level.label">
        <span class="legend__swatch" :style="{ background: level.colour }" />
        <span class="legend__label">{{ level.label }}</span>
        <span class="legend__range">{{ level.range }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.legend {
  padding: 10px 12px;
  width: 172px;
}

.legend__title {
  margin: 0 0 8px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
}

.legend ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 6px;
}

.legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
}

.legend__swatch {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.legend__label {
  flex: 1;
}

.legend__range {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
</style>

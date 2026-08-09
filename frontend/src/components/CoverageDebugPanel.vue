<script setup>
import { ref, onMounted } from 'vue'
import * as grid from '@/services/engine/grid.js'
import * as localApi from '@/services/engine/localApi.js'
import { segmentVsMidpointCoverage } from '@/services/engine/route-audit.js'
import AppIcon from './AppIcon.vue'

const emit = defineEmits(['changed'])

const segment = ref(grid.getMatchMethod() === 'segment')
const loading = ref(false)
const stats = ref(null)
const collapsed = ref(false)

async function refresh() {
  loading.value = true
  try {
    const loads = await localApi.debugLoads()
    stats.value = segmentVsMidpointCoverage(loads)
  } finally {
    loading.value = false
  }
}

// A single `@change` handler reading `event.target.checked` directly — mixing
// v-model with an explicit @change on the same native event risks reading
// `segment.value` before v-model's own listener has committed the update.
async function onToggle(event) {
  segment.value = event.target.checked
  grid.setMatchMethod(segment.value ? 'segment' : 'midpoint')
  await refresh()
  emit('changed')
}

onMounted(refresh)

defineExpose({ refresh })
</script>

<template>
  <div class="debug card" :class="{ 'is-collapsed': collapsed }">
    <button class="debug__header" @click="collapsed = !collapsed">
      <AppIcon name="info" :size="14" />
      <span>Sensor matching debug</span>
      <AppIcon name="chevron" :size="14" class="debug__collapse-icon" :class="{ 'is-open': !collapsed }" />
    </button>

    <div v-if="!collapsed" class="debug__body">
      <label class="debug__toggle">
        <input type="checkbox" :checked="segment" @change="onToggle" />
        <span>Match by nearest point on block <em>(off = distance to block midpoint only, the old behaviour)</em></span>
      </label>

      <p class="debug__radius">Match radius: {{ grid.SENSOR_RADIUS_M }} m, either way — only how distance is measured changes.</p>

      <p v-if="loading" class="debug__loading">Computing…</p>

      <template v-else-if="stats">
        <table class="debug__stats">
          <tbody>
            <tr>
              <td>Old (midpoint only)</td>
              <td>{{ stats.old_midpoint_covered }}/{{ stats.total_blocks }} blocks ({{ stats.old_midpoint_pct }}%)</td>
            </tr>
            <tr>
              <td>New (nearest point on segment)</td>
              <td>{{ stats.new_segment_covered }}/{{ stats.total_blocks }} blocks ({{ stats.new_segment_pct }}%)</td>
            </tr>
            <tr class="debug__diff" :class="{ 'is-negative': stats.blocks_gained < 0, 'is-positive': stats.blocks_gained > 0 }">
              <td>Difference</td>
              <td>{{ stats.blocks_gained > 0 ? '+' : '' }}{{ stats.blocks_gained }} blocks</td>
            </tr>
          </tbody>
        </table>
      </template>

      <button class="debug__refresh" @click="refresh">
        <AppIcon name="refresh" :size="13" />
        Refresh against live data
      </button>
    </div>
  </div>
</template>

<style scoped>
.debug {
  width: 240px;
  padding: 10px 12px;
  font-size: 12px;
}

.debug__header {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.debug__collapse-icon {
  margin-left: auto;
  transition: transform 160ms ease;
}

.debug__collapse-icon.is-open {
  transform: rotate(90deg);
}

.debug__body {
  margin-top: 10px;
  display: grid;
  gap: 10px;
}

.debug__toggle {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
  line-height: 1.4;
}

.debug__toggle input {
  margin-top: 2px;
  flex-shrink: 0;
}

.debug__toggle em {
  display: block;
  font-style: normal;
  color: var(--text-faint);
  font-size: 11px;
}

.debug__radius {
  margin: 0;
  color: var(--text-faint);
  font-size: 11px;
}

.debug__stats {
  width: 100%;
  border-collapse: collapse;
}

.debug__stats td {
  padding: 3px 0;
  font-variant-numeric: tabular-nums;
}

.debug__stats td:first-child {
  color: var(--text-muted);
}

.debug__stats td:last-child {
  text-align: right;
}

.debug__diff td {
  font-weight: 500;
  border-top: 1px solid var(--border);
  padding-top: 5px;
}

.debug__diff.is-negative td {
  color: var(--overwhelming);
}

.debug__diff.is-positive td {
  color: var(--calm);
}

.debug__loading {
  margin: 0;
  color: var(--text-faint);
}

.debug__refresh {
  display: flex;
  align-items: center;
  gap: 6px;
  justify-content: center;
  padding: 6px;
  border-radius: var(--radius-card);
  background: var(--surface-sunken);
  color: var(--text-muted);
  font-size: 11px;
}

.debug__refresh:hover {
  background: #e8eaed;
}
</style>

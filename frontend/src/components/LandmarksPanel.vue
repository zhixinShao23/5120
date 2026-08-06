<script setup>
import { computed, ref } from 'vue'
import { scoreBand } from '@/services/routing.js'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  landmarks: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'focus-landmark', 'route-to'])

const filter = ref('all')
const expandedId = ref(null)

const categories = computed(() => {
  const seen = new Map()
  for (const lm of props.landmarks) seen.set(lm.category, (seen.get(lm.category) ?? 0) + 1)
  return [...seen.entries()].map(([id, count]) => ({ id, count }))
})

const visible = computed(() =>
  filter.value === 'all'
    ? props.landmarks
    : props.landmarks.filter((lm) => lm.category === filter.value),
)

const ICONS = {
  Park: 'park',
  Museum: 'star',
  Library: 'info',
  Culture: 'star',
  Market: 'place',
  'Street art': 'place',
}

function toggle(landmark) {
  expandedId.value = expandedId.value === landmark.id ? null : landmark.id
  emit('focus-landmark', landmark)
}
</script>

<template>
  <section class="landmarks card" aria-label="Potential landmarks">
    <header class="landmarks__header">
      <button class="icon-button" title="Back to search" @click="emit('close')">
        <AppIcon name="close" :size="20" />
        <span class="sr-only">Close landmarks</span>
      </button>
      <div>
        <h1 class="landmarks__title">Potential landmarks</h1>
        <p class="landmarks__subtitle">{{ landmarks.length }} places, calmest first</p>
      </div>
    </header>

    <div class="landmarks__filters scroll-area">
      <button
        class="chip"
        :aria-pressed="filter === 'all'"
        @click="filter = 'all'"
      >
        All
      </button>
      <button
        v-for="category in categories"
        :key="category.id"
        class="chip"
        :aria-pressed="filter === category.id"
        @click="filter = category.id"
      >
        {{ category.id }}
        <span class="landmarks__count">{{ category.count }}</span>
      </button>
    </div>

    <ul class="landmarks__list scroll-area">
      <li
        v-for="landmark in visible"
        :key="landmark.id"
        class="landmark"
        :class="{ 'is-open': expandedId === landmark.id }"
      >
        <button class="landmark__main" @click="toggle(landmark)">
          <span
            class="landmark__icon"
            :style="{
              color: scoreBand(landmark.sensoryScore).colour,
              background: `${scoreBand(landmark.sensoryScore).colour}14`,
            }"
          >
            <AppIcon :name="ICONS[landmark.category] ?? 'place'" :size="18" />
          </span>

          <span class="landmark__body">
            <span class="landmark__name">{{ landmark.name }}</span>
            <span class="landmark__meta">
              {{ landmark.category }}
              <span aria-hidden="true">·</span>
              <span :style="{ color: scoreBand(landmark.sensoryScore).colour }">
                {{ scoreBand(landmark.sensoryScore).label }}
              </span>
            </span>
            <span class="landmark__quiet">
              <AppIcon name="clock" :size="12" />
              Quietest {{ landmark.quietHours }}
            </span>
          </span>

          <span
            class="landmark__score"
            :style="{ color: scoreBand(landmark.sensoryScore).colour }"
            :title="`Sensory load ${landmark.sensoryScore} of 100`"
          >
            {{ landmark.sensoryScore }}
          </span>
        </button>

        <div v-if="expandedId === landmark.id" class="landmark__detail">
          <p class="landmark__blurb">{{ landmark.blurb }}</p>
          <ul class="landmark__features">
            <li v-for="feature in landmark.features" :key="feature">{{ feature }}</li>
          </ul>
          <button class="landmark__action" @click="emit('route-to', landmark)">
            <AppIcon name="directions" :size="16" />
            Route here
          </button>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.landmarks {
  display: flex;
  flex-direction: column;
  width: var(--panel-width);
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 100px);
  overflow: hidden;
}

.landmarks__header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px 10px 8px;
}

.landmarks__title {
  margin: 0;
  font-size: 15px;
  font-weight: 500;
}

.landmarks__subtitle {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.landmarks__filters {
  display: flex;
  gap: 8px;
  padding: 2px 16px 14px;
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid #e8eaed;
  /* An overlay scrollbar here would sit on top of the chips. */
  scrollbar-width: none;
}

.landmarks__filters::-webkit-scrollbar {
  display: none;
}

.landmarks__filters .chip {
  box-shadow: none;
  border: 1px solid var(--border);
  flex-shrink: 0;
}

.landmarks__count {
  color: var(--text-faint);
  font-weight: 400;
}

.landmarks__list {
  flex: 1;
  margin: 0;
  padding: 0;
  list-style: none;
  min-height: 0;
}

.landmark {
  border-bottom: 1px solid #f1f3f4;
}

.landmark.is-open {
  background: #f8fbff;
}

.landmark__main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  padding: 12px 16px;
  text-align: left;
}

.landmark__main:hover {
  background: rgba(60, 64, 67, 0.04);
}

.landmark__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  flex-shrink: 0;
}

.landmark__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.landmark__name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.landmark__meta {
  display: flex;
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
}

.landmark__quiet {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-faint);
}

.landmark__score {
  font-size: 16px;
  font-weight: 500;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}

.landmark__detail {
  padding: 0 16px 16px 64px;
}

.landmark__blurb {
  margin: 0 0 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
}

.landmark__features {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}

.landmark__features li {
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  background: var(--surface-sunken);
  font-size: 11px;
  color: var(--text-muted);
}

.landmark__action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 500;
}

.landmark__action:hover {
  background: #1765cc;
}
</style>

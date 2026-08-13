<script setup>
import AppIcon from './AppIcon.vue'

defineProps({
  refuges: { type: Array, default: () => [] },
})

defineEmits(['route-to', 'focus-refuge'])
</script>

<template>
  <section v-if="refuges.length" class="nearby card" aria-label="Quiet spots along this route">
    <header class="nearby__header">
      <AppIcon name="park" :size="16" />
      <h2 class="nearby__title">
        {{ refuges.length }} quiet {{ refuges.length === 1 ? 'spot' : 'spots' }} on this route
      </h2>
    </header>

    <ul class="nearby__list scroll-area">
      <li
        v-for="refuge in refuges"
        :key="refuge.id"
        class="nearby__item"
        @click="$emit('focus-refuge', refuge)"
      >
        <span class="nearby__info">
          <span class="nearby__name">{{ refuge.name }}</span>
          <span class="nearby__meta">{{ refuge.category }} · {{ refuge.distanceM }} m away</span>
        </span>
        <button
          class="nearby__btn"
          title="Get directions here"
          @click.stop="$emit('route-to', refuge)"
        >
          <AppIcon name="directions" :size="16" />
          <span class="sr-only">Get directions to {{ refuge.name }}</span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.nearby {
  width: 260px;
  max-width: calc(100vw - 24px);
  max-height: 260px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.nearby__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px 10px;
  color: var(--text-muted);
  border-bottom: 1px solid var(--divider);
}

.nearby__title {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
}

.nearby__list {
  margin: 0;
  padding: 4px 0;
  list-style: none;
  overflow-y: auto;
  min-height: 0;
}

.nearby__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  cursor: pointer;
}

.nearby__item:hover {
  background: var(--hover-weak);
}

.nearby__info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nearby__name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nearby__meta {
  font-size: 11px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nearby__btn {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--accent-strong);
  background: var(--accent-soft);
}

.nearby__btn:hover {
  background: color-mix(in srgb, var(--accent-strong) 20%, var(--accent-soft));
}
</style>

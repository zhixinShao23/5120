<script setup>
import AppIcon from './AppIcon.vue'

defineProps({
  active: { type: Object, required: true },
})

const emit = defineEmits(['toggle'])

/** The quick filters across the top, mirroring the Maps category row. */
const CHIPS = [
  { id: 'crowd', label: 'Live crowds', icon: 'people' },
  { id: 'landmarks', label: 'Landmarks', icon: 'star' },
  { id: 'quiet', label: 'Quiet spots', icon: 'park' },
]
</script>

<template>
  <nav class="chips scroll-area" aria-label="Map layers">
    <button
      v-for="chip in CHIPS"
      :key="chip.id"
      class="chip"
      :aria-pressed="Boolean(active[chip.id])"
      @click="emit('toggle', chip.id)"
    >
      <AppIcon :name="chip.icon" :size="16" />
      {{ chip.label }}
    </button>
  </nav>
</template>

<style scoped>
.chips {
  display: flex;
  gap: 8px;
  padding: 4px 12px 12px;
  overflow-x: auto;
  overflow-y: hidden;
  /* The row scrolls, but must not eat clicks on the map either side of it. */
  pointer-events: auto;
  scrollbar-width: none;
}

.chips::-webkit-scrollbar {
  display: none;
}
</style>

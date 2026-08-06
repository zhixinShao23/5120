<script setup>
import { ref } from 'vue'
import PlaceInput from './PlaceInput.vue'
import AppIcon from './AppIcon.vue'

defineProps({
  modelValue: { type: Object, default: null },
})

const emit = defineEmits(['update:modelValue', 'directions', 'menu', 'submit'])

const input = ref(null)

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="search-bar card">
    <button class="icon-button search-bar__menu" title="Menu" @click="emit('menu')">
      <AppIcon name="menu" :size="22" />
      <span class="sr-only">Open menu</span>
    </button>

    <PlaceInput
      ref="input"
      :model-value="modelValue"
      placeholder="Search QuietWay Melbourne"
      aria-label="Search for a destination"
      @update:model-value="emit('update:modelValue', $event)"
      @submit="emit('submit', $event)"
    />

    <button class="icon-button search-bar__search" title="Search">
      <AppIcon name="search" :size="20" />
      <span class="sr-only">Search</span>
    </button>

    <span class="search-bar__divider" />

    <button class="search-bar__directions" title="Get sensory-friendly directions" @click="emit('directions')">
      <AppIcon name="directions" :size="22" />
      <span class="sr-only">Get directions</span>
    </button>
  </div>
</template>

<style scoped>
.search-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 48px;
  padding: 0 6px 0 4px;
  width: var(--panel-width);
  max-width: calc(100vw - 24px);
}

.search-bar__menu {
  color: var(--text-muted);
  flex-shrink: 0;
}

.search-bar :deep(.place-input) {
  padding: 0 4px;
}

.search-bar__search {
  color: var(--accent);
  width: 36px;
  height: 36px;
  flex-shrink: 0;
}

.search-bar__divider {
  width: 1px;
  height: 24px;
  background: var(--border);
  flex-shrink: 0;
}

.search-bar__directions {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: var(--accent);
  flex-shrink: 0;
  transition: background 120ms ease;
}

.search-bar__directions:hover {
  background: var(--accent-soft);
}
</style>

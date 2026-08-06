<script setup>
import { ref, watch, computed } from 'vue'
import { searchPlaces } from '@/services/api.js'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  modelValue: { type: Object, default: null },
  placeholder: { type: String, default: 'Search' },
  ariaLabel: { type: String, default: 'Search for a place' },
})

const emit = defineEmits(['update:modelValue', 'submit'])

const query = ref(props.modelValue?.name ?? '')
const suggestions = ref([])
const open = ref(false)
const highlighted = ref(-1)
const inputEl = ref(null)

let debounce = null

/** Keep the visible text in step when the parent swaps or clears the place. */
watch(
  () => props.modelValue,
  (place) => {
    if (place?.name !== query.value) query.value = place?.name ?? ''
  },
)

watch(query, (value) => {
  clearTimeout(debounce)
  // The selected place is stale as soon as the text diverges from it.
  if (props.modelValue && value !== props.modelValue.name) emit('update:modelValue', null)

  if (!value.trim()) {
    suggestions.value = []
    open.value = false
    return
  }

  debounce = setTimeout(async () => {
    suggestions.value = await searchPlaces(value)
    open.value = suggestions.value.length > 0
    highlighted.value = -1
  }, 140)
})

function choose(place) {
  emit('update:modelValue', place)
  query.value = place.name
  suggestions.value = []
  open.value = false
  highlighted.value = -1
  emit('submit', place)
}

function onKeydown(event) {
  if (!open.value) {
    if (event.key === 'Enter' && suggestions.value.length === 0 && query.value.trim()) {
      // Enter on free text: take the best match rather than doing nothing.
      searchPlaces(query.value).then((results) => results[0] && choose(results[0]))
    }
    return
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    highlighted.value = (highlighted.value + 1) % suggestions.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    highlighted.value =
      highlighted.value <= 0 ? suggestions.value.length - 1 : highlighted.value - 1
  } else if (event.key === 'Enter') {
    event.preventDefault()
    choose(suggestions.value[Math.max(0, highlighted.value)])
  } else if (event.key === 'Escape') {
    open.value = false
  }
}

/** Delay the close so a click on a suggestion still lands before blur wins. */
function onBlur() {
  setTimeout(() => {
    open.value = false
  }, 150)
}

function clear() {
  query.value = ''
  emit('update:modelValue', null)
  inputEl.value?.focus()
}

const listboxId = computed(() => `places-${props.ariaLabel.replace(/\s+/g, '-').toLowerCase()}`)

defineExpose({ focus: () => inputEl.value?.focus() })
</script>

<template>
  <div class="place-input">
    <input
      ref="inputEl"
      v-model="query"
      type="text"
      role="combobox"
      autocomplete="off"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      :aria-controls="listboxId"
      :placeholder="placeholder"
      @keydown="onKeydown"
      @focus="open = suggestions.length > 0"
      @blur="onBlur"
    />

    <button v-if="query" class="place-input__clear" title="Clear" @click="clear">
      <AppIcon name="close" :size="16" />
      <span class="sr-only">Clear</span>
    </button>

    <ul v-if="open" :id="listboxId" class="place-input__list card" role="listbox">
      <li
        v-for="(place, index) in suggestions"
        :key="place.id"
        role="option"
        :aria-selected="index === highlighted"
        :class="{ 'is-highlighted': index === highlighted }"
        @mousedown.prevent="choose(place)"
        @mouseenter="highlighted = index"
      >
        <AppIcon name="place" :size="18" class="place-input__pin" />
        <span class="place-input__name">{{ place.name }}</span>
        <span class="place-input__kind">{{ place.kind }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.place-input {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
}

.place-input input {
  width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 14px;
}

.place-input input::placeholder {
  color: var(--text-faint);
}

.place-input input:focus {
  outline: none;
}

.place-input__clear {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: var(--text-faint);
  flex-shrink: 0;
}

.place-input__clear:hover {
  background: rgba(60, 64, 67, 0.08);
  color: var(--text-muted);
}

.place-input__list {
  position: absolute;
  top: calc(100% + 10px);
  left: -12px;
  right: -12px;
  z-index: 20;
  margin: 0;
  padding: 6px 0;
  list-style: none;
  max-height: 300px;
  overflow-y: auto;
}

.place-input__list li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 16px;
  cursor: pointer;
}

.place-input__list li.is-highlighted {
  background: var(--surface-sunken);
}

.place-input__pin {
  color: var(--text-faint);
  flex-shrink: 0;
}

.place-input__name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.place-input__kind {
  font-size: 11px;
  color: var(--text-faint);
  text-transform: capitalize;
}
</style>

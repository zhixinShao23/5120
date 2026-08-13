<script setup>
import { computed, ref } from 'vue'
import AppIcon from './AppIcon.vue'
import { theme } from '../theme.js'

const props = defineProps({
  // null = "now" (live crowd data). Otherwise a datetime-local string
  // ("YYYY-MM-DDTHH:mm") naming a future weekday and hour to predict for.
  modelValue: { type: String, default: null },
})

const emit = defineEmits(['update:modelValue'])

// The picker stays visible once opened even if its value is briefly empty
// mid-edit, so it doesn't collapse under the user while they're typing.
const showPicker = ref(Boolean(props.modelValue))

const inputEl = ref(null)

/**
 * The input's own text is invisible (see .planfor__input) — clicking
 * whatever segment sits under the cursor would otherwise just focus that
 * segment for inline editing, with no visible caret to show it. showPicker()
 * opens the full calendar/time popup instead, from a click anywhere on the
 * field, matching what the visible "button-like" field implies. Falls back
 * to the browser's default click behaviour on browsers without it (Safari).
 */
function openPicker() {
  inputEl.value?.showPicker?.()
}

function pad(n) {
  return String(n).padStart(2, '0')
}

function toLocalInputValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Default target when the user opens the picker: next hour, on the hour. */
function defaultFutureValue() {
  const d = new Date(Date.now() + 60 * 60 * 1000)
  d.setMinutes(0, 0, 0)
  return toLocalInputValue(d)
}

const minValue = computed(() => toLocalInputValue(new Date()))

function useNow() {
  showPicker.value = false
  if (props.modelValue) emit('update:modelValue', null)
}

function planAhead() {
  showPicker.value = true
  if (!props.modelValue) emit('update:modelValue', defaultFutureValue())
}

function onChange(event) {
  emit('update:modelValue', event.target.value || null)
}

const label = computed(() => {
  if (!props.modelValue) return null
  const d = new Date(props.modelValue)
  if (Number.isNaN(d.getTime())) return null
  const weekday = d.toLocaleDateString(undefined, { weekday: 'long' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${weekday} at ${time}`
})

// The native input's own text is hidden (see .planfor__input) in favour of
// this — short, locale-formatted, and legible — shown behind it instead.
// Falls back to the raw value if it's still mid-edit and not a valid date
// yet (typing a date inline, one segment at a time), so the field is never
// blank while the browser's own control still has something in it.
const fieldLabel = computed(() => {
  if (!props.modelValue) return 'Choose a date and time'
  const d = new Date(props.modelValue)
  if (Number.isNaN(d.getTime())) return props.modelValue
  const day = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
})
</script>

<template>
  <fieldset class="planfor">
    <legend class="planfor__legend">When</legend>

    <div class="segmented" role="group" aria-label="Plan for now or a future time">
      <button
        type="button"
        class="segmented__btn"
        :class="{ 'is-active': !modelValue }"
        :aria-pressed="!modelValue"
        @click="useNow"
      >
        Now
      </button>
      <button
        type="button"
        class="segmented__btn"
        :class="{ 'is-active': !!modelValue }"
        :aria-pressed="!!modelValue"
        @click="planAhead"
      >
        Plan ahead
      </button>
    </div>

    <div v-if="showPicker" class="planfor__field">
      <input
        ref="inputEl"
        type="datetime-local"
        class="planfor__input"
        :style="{ colorScheme: theme }"
        :value="modelValue ?? ''"
        :min="minValue"
        aria-label="Date and time to plan for"
        @input="onChange"
        @change="onChange"
        @click="openPicker"
      />
      <!-- Purely decorative, painted over the input above (later in DOM =
           on top). `pointer-events: none` lets every click/keystroke pass
           straight through to the real, accessible control underneath. -->
      <div class="planfor__display" aria-hidden="true">
        <AppIcon name="clock" :size="14" class="planfor__display-icon" />
        <span>{{ fieldLabel }}</span>
      </div>
    </div>

    <p v-if="label" class="planfor__hint">
      Estimated using historical patterns.
    </p>
  </fieldset>
</template>

<style scoped>
.planfor {
  border: none;
  margin: 0;
  padding: 0;
}

.planfor__legend {
  padding: 0 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

/* The real input and its decorative stand-in occupy the same box — grid
   with both children on cell 1/1 is the simplest way to stack them without
   juggling absolute-positioning offsets. */
.planfor__field {
  position: relative;
  display: grid;
  margin-top: 8px;
}

.planfor__field > * {
  grid-area: 1 / 1;
}

/* Flat and borderless, like every other control in this panel (see the
   segmented track above and CrowdLimitPresets.vue below it) — a boxed,
   bordered input showing the browser's raw "14-08-2026 02:00" text was the
   one element here that still looked like a plain, unstyled form field. Its
   own text is made invisible; .planfor__display underneath shows a
   formatted stand-in instead, while this stays the real, focusable,
   fully-functional control — same click target, same keyboard behaviour,
   same native calendar/time popup. */
.planfor__input {
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-card);
  background: transparent;
  color: transparent;
  caret-color: transparent;
  font-size: 13px;
  cursor: pointer;
  /* color-scheme is bound inline to the app's own theme (not "light dark",
     which defers to the OS/browser preference instead) — otherwise the
     native calendar popup follows whatever the system prefers and can end
     up dark while this app is switched to light, or vice versa. */
}

.planfor__display {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 10px;
  border-radius: var(--radius-card);
  background: var(--surface-sunken);
  color: var(--text);
  font-size: 13px;
  pointer-events: none;
  transition: box-shadow 120ms ease;
}

.planfor__display-icon {
  flex-shrink: 0;
  color: var(--text-faint);
}

.planfor__input:focus-visible ~ .planfor__display {
  box-shadow: 0 0 0 2px var(--accent);
}

.planfor__hint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-faint);
}
</style>

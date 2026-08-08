<script setup>
import { computed } from 'vue'
import { MAX_FLOW, flowBand } from '@/services/routing.js'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  modelValue: { type: Number, required: true },
})

const emit = defineEmits(['update:modelValue'])

const MIN = 10
const STEP = 5

const band = computed(() => flowBand(props.modelValue))

/** Thumb position as a percentage, for the value bubble and track fill. */
const percent = computed(() => ((props.modelValue - MIN) / (MAX_FLOW - MIN)) * 100)

function onInput(event) {
  emit('update:modelValue', Number(event.target.value))
}
</script>

<template>
  <fieldset class="limit">
    <legend class="limit__legend">Busiest crowd you're comfortable with</legend>

    <div class="limit__reading">
      <AppIcon name="people" :size="16" :style="{ color: band.colour }" />
      <span class="limit__value" :style="{ color: band.colour }">
        ≤ {{ modelValue }} <em>people/min</em>
      </span>
      <span class="limit__band" :style="{ color: band.colour }">{{ band.label }}</span>
    </div>

    <div class="limit__slider">
      <input
        type="range"
        :min="MIN"
        :max="MAX_FLOW"
        :step="STEP"
        :value="modelValue"
        :style="{ '--fill': `${percent}%`, '--thumb-colour': band.colour }"
        aria-label="Maximum people per minute you are comfortable passing"
        :aria-valuetext="`${modelValue} people per minute`"
        @input="onInput"
      />
      <div class="limit__scale" aria-hidden="true">
        <span>{{ MIN }}</span>
        <span>quiet</span>
        <span>busy</span>
        <span>{{ MAX_FLOW }}</span>
      </div>
    </div>

    <p class="limit__hint">
      Routes are steered around any point where more than {{ modelValue }} people pass per minute.
    </p>
  </fieldset>
</template>

<style scoped>
.limit {
  border: none;
  margin: 0;
  padding: 0;
}

.limit__legend {
  padding: 0 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.limit__reading {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}

.limit__reading svg {
  align-self: center;
}

.limit__value {
  font-size: 18px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}

.limit__value em {
  font-size: 12px;
  font-style: normal;
  font-weight: 400;
  color: var(--text-muted);
}

.limit__band {
  margin-left: auto;
  font-size: 12px;
  font-weight: 500;
}

.limit__slider input {
  width: 100%;
  height: 20px;
  margin: 0;
  appearance: none;
  background: transparent;
  cursor: pointer;
}

/* Track: green -> red gradient under a neutral overlay past the thumb. */
.limit__slider input::-webkit-slider-runnable-track {
  height: 6px;
  border-radius: 3px;
  background:
    linear-gradient(to right, transparent var(--fill), var(--surface-sunken) var(--fill)),
    linear-gradient(to right, #12805c, #b8860b 45%, #e8710a 70%, #d93025);
}

.limit__slider input::-moz-range-track {
  height: 6px;
  border-radius: 3px;
  background:
    linear-gradient(to right, transparent var(--fill), var(--surface-sunken) var(--fill)),
    linear-gradient(to right, #12805c, #b8860b 45%, #e8710a 70%, #d93025);
}

.limit__slider input::-webkit-slider-thumb {
  appearance: none;
  width: 18px;
  height: 18px;
  margin-top: -6px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--thumb-colour);
  box-shadow: 0 1px 3px rgba(60, 64, 67, 0.4);
}

.limit__slider input::-moz-range-thumb {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  border: 3px solid var(--thumb-colour);
  box-shadow: 0 1px 3px rgba(60, 64, 67, 0.4);
}

.limit__scale {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-faint);
}

.limit__hint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-faint);
}
</style>

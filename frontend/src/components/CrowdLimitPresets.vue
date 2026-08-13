<script setup>
import { computed } from 'vue'
import { COMFORT_PRESETS, COMFORT_PRESETS_PREDICTED } from '@/services/routing.js'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  modelValue: { type: Number, required: true },
  // Predicted density lives on a much smaller scale than live (see
  // FLOW_BANDS_PREDICTED) — without this, "High" would mean 150/min, a
  // figure the historical baseline never once reaches, and the control
  // would stop differentiating anything in Plan-ahead mode.
  predicted: { type: Boolean, default: false },
})

const emit = defineEmits(['update:modelValue'])

const presets = computed(() => (props.predicted ? COMFORT_PRESETS_PREDICTED : COMFORT_PRESETS))

const active = computed(
  () => presets.value.find((p) => p.value === props.modelValue) ?? null,
)

const hint = computed(() => {
  const value = active.value?.value ?? props.modelValue
  return props.predicted
    ? `Avoids anywhere predicted to be busier than ${value} people a minute.`
    : `Avoids anywhere busier than ${value} people a minute.`
})
</script>

<template>
  <fieldset class="limit-presets">
    <legend class="limit-presets__legend">Busiest crowd you're comfortable with</legend>

    <div class="segmented" role="group" aria-label="Comfort level">
      <button
        v-for="preset in presets"
        :key="preset.id"
        type="button"
        class="segmented__btn"
        :class="{ 'is-active': active?.id === preset.id }"
        :style="{ '--preset-colour': preset.colour }"
        :aria-pressed="active?.id === preset.id"
        @click="emit('update:modelValue', preset.value)"
      >
        <!-- One person / two / a crowd: the icon shows how busy each level
             means, and carries the band colour, so the picker speaks the
             same visual language as the route cards and the map legend. -->
        <AppIcon
          class="limit-presets__icon"
          :name="preset.icon"
          :size="17"
          :style="{ color: preset.colour }"
        />
        {{ preset.label }}
      </button>
    </div>

    <p class="limit-presets__hint">{{ hint }}</p>
  </fieldset>
</template>

<style scoped>
.limit-presets {
  border: none;
  margin: 0;
  padding: 0;
}

.limit-presets__legend {
  padding: 0 0 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
}

.limit-presets__icon {
  flex-shrink: 0;
  /* Dimmed until chosen, so the track reads as one calm control rather than
     three competing colour marks. */
  opacity: 0.5;
  transition: opacity 120ms ease;
}

.segmented__btn.is-active .limit-presets__icon {
  opacity: 1;
}

/* The primary control in this panel, so a touch larger than the When
   toggle above it — same shape, slightly more weight in the hierarchy. */
.segmented__btn {
  font-size: 14px;
}

.segmented__btn.is-active {
  color: var(--preset-colour);
}

.limit-presets__hint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-faint);
}
</style>

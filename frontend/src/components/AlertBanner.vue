<script setup>
import AppIcon from './AppIcon.vue'

defineProps({
  alert: { type: Object, required: true },
})

const emit = defineEmits(['dismiss', 'action'])
</script>

<template>
  <div class="alert card" role="status">
    <span class="alert__icon">
      <AppIcon name="bell" :size="18" />
    </span>

    <div class="alert__body">
      <p class="alert__title">{{ alert.title }}</p>
      <p class="alert__detail">{{ alert.detail }}</p>
    </div>

    <button v-if="alert.actionLabel" class="alert__action" @click="emit('action')">
      {{ alert.actionLabel }}
    </button>

    <button class="icon-button alert__dismiss" title="Dismiss" @click="emit('dismiss')">
      <AppIcon name="close" :size="18" />
      <span class="sr-only">Dismiss alert</span>
    </button>
  </div>
</template>

<style scoped>
.alert {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 8px 10px 14px;
  max-width: min(560px, calc(100vw - 24px));
  border-left: 4px solid var(--overwhelming);
  animation: rise 220ms ease-out;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

.alert__icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: var(--overwhelming-soft);
  color: var(--overwhelming);
  flex-shrink: 0;
}

.alert__body {
  flex: 1;
  min-width: 0;
}

.alert__title {
  margin: 0;
  font-size: 13px;
  font-weight: 500;
}

.alert__detail {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.alert__action {
  padding: 7px 14px;
  border-radius: var(--radius-pill);
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 13px;
  font-weight: 500;
  flex-shrink: 0;
}

.alert__action:hover {
  background: var(--info-soft);
}

.alert__dismiss {
  width: 32px;
  height: 32px;
  color: var(--text-faint);
  flex-shrink: 0;
}
</style>

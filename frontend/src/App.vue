<script setup>
import NavBar from './components/NavBar.vue'
</script>

<template>
  <div class="shell">
    <NavBar />
    <main class="shell__content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  width: 100%;
}

.shell__content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
</style>

<script setup>
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'
import { theme, toggleTheme } from '../theme.js'

const LINKS = [
  { to: '/', label: 'Home' },
  { to: '/map', label: 'Map' },
  { to: '/about', label: 'About' },
]
</script>

<template>
  <header class="nav">
    <RouterLink to="/" class="nav__brand">
      <span class="nav__logo" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M6 20c-2-4 0-11 6-14 4 6 4 12 0 16-3-1-5-1-6-2z"
            fill="#fff"
          />
        </svg>
      </span>
      <span class="nav__name">QuietWay</span>
    </RouterLink>

    <nav class="nav__links" aria-label="Main">
      <RouterLink v-for="link in LINKS" :key="link.to" :to="link.to" class="nav__link">
        {{ link.label }}
      </RouterLink>
    </nav>

    <button
      class="nav__theme"
      :title="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'"
      @click="toggleTheme"
    >
      <AppIcon :name="theme === 'dark' ? 'sun' : 'moon'" :size="19" />
      <span class="sr-only">{{ theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode' }}</span>
    </button>
  </header>
</template>

<style scoped>
.nav {
  display: flex;
  align-items: center;
  gap: 40px;
  height: var(--nav-height);
  padding: 0 24px;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.nav__brand {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: var(--text);
}

.nav__logo {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: var(--calm);
  flex-shrink: 0;
}

.nav__name {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.nav__links {
  display: flex;
  align-items: center;
  gap: 28px;
}

.nav__link {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-muted);
  text-decoration: none;
  padding: 8px 2px;
  border-bottom: 2px solid transparent;
  transition: color 120ms ease, border-color 120ms ease;
}

.nav__link:hover {
  color: var(--text);
}

.nav__link.router-link-exact-active {
  color: var(--text);
  border-bottom-color: var(--calm);
}

.nav__theme {
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  margin-left: auto;
  border-radius: 50%;
  color: var(--text-muted);
  flex-shrink: 0;
  transition: background 120ms ease, color 120ms ease;
}

.nav__theme:hover {
  background: var(--hover-strong);
  color: var(--text);
}

@media (max-width: 640px) {
  .nav {
    gap: 20px;
    padding: 0 16px;
  }

  .nav__name {
    display: none;
  }

  .nav__links {
    gap: 16px;
  }
}
</style>

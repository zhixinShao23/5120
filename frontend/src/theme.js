/**
 * Dark-mode state — a single ref shared by every consumer (the NavBar
 * toggle, MapView's tile choice), backed by the same localStorage key and
 * document attribute the inline script in index.html sets before first
 * paint (see that file for why it has to run there and not here).
 */

import { ref } from 'vue'

const STORAGE_KEY = 'quietway-theme'

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export const theme = ref(currentTheme())

export function toggleTheme() {
  theme.value = theme.value === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = theme.value
  localStorage.setItem(STORAGE_KEY, theme.value)
}

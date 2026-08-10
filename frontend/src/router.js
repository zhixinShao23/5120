import { createRouter, createWebHistory } from 'vue-router'
import HomePage from './views/HomePage.vue'
import MapPage from './views/MapPage.vue'
import AboutPage from './views/AboutPage.vue'

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: HomePage },
    { path: '/map', name: 'map', component: MapPage },
    { path: '/about', name: 'about', component: AboutPage },
  ],
  scrollBehavior() {
    return { top: 0 }
  },
})

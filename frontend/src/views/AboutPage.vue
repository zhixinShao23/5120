<script setup>
import AppIcon from '../components/AppIcon.vue'

const FEATURES = [
  {
    icon: 'route',
    title: 'Sensory-scored routing',
    body: 'Every route is priced by how crowded it actually is right now, not just distance — the calmest option and the fastest one are shown side by side.',
  },
  {
    icon: 'people',
    title: 'Live crowd data',
    body: 'Pedestrian counts come from the City of Melbourne’s sensor network, refreshed continuously, with a cached snapshot as a fallback when the feed is unavailable.',
  },
  {
    icon: 'park',
    title: 'Sensory refuges',
    body: 'Quiet parks, libraries and low-stimulus spaces across the CBD are rated and mapped, so a break is never far from wherever you are.',
  },
]
</script>

<template>
  <div class="about">
    <header class="about__hero">
      <h1 class="about__title">About QuietWay</h1>
      <p class="about__lede">
        A sensory-friendly route planner for the City of Melbourne CBD — built for
        anyone who finds crowded, loud streets overwhelming, and wants a walk that
        respects that.
      </p>
    </header>

    <section class="about__features">
      <article v-for="feature in FEATURES" :key="feature.title" class="feature card">
        <span class="feature__icon"><AppIcon :name="feature.icon" :size="20" /></span>
        <h2 class="feature__title">{{ feature.title }}</h2>
        <p class="feature__body">{{ feature.body }}</p>
      </article>
    </section>

    <section class="about__how card">
      <h2 class="about__section-title">How it scores a route</h2>
      <p class="about__text">
        Every block of the Hoddle Grid is matched to the pedestrian sensors within
        range. A route's cost weighs walking distance against the busiest sensor
        reading anywhere along it, plus whether foot traffic is moving toward you
        or with you — so the "calm" route isn't just short, it's the one your
        comfort limit says you should actually enjoy walking.
      </p>
    </section>

    <p class="about__attribution">
      Pedestrian and sensory data attribution: City of Melbourne, CC BY 4.0.
    </p>
  </div>
</template>

<style scoped>
.about {
  max-width: 860px;
  margin: 0 auto;
  padding: 48px 24px 64px;
}

.about__hero {
  margin-bottom: 32px;
}

.about__title {
  margin: 0 0 12px;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.about__lede {
  margin: 0;
  font-size: 16px;
  line-height: 1.6;
  color: var(--text-muted);
  max-width: 640px;
}

.about__features {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 24px;
}

.feature {
  padding: 20px;
}

.feature__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--calm-soft);
  color: var(--calm);
  margin-bottom: 14px;
}

.feature__title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}

.feature__body {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-muted);
}

.about__how {
  padding: 24px;
  margin-bottom: 20px;
}

.about__section-title {
  margin: 0 0 10px;
  font-size: 16px;
  font-weight: 600;
}

.about__text {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--text-muted);
}

.about__attribution {
  margin: 0;
  font-size: 12px;
  color: var(--text-faint);
}

@media (max-width: 720px) {
  .about__features {
    grid-template-columns: 1fr;
  }
}
</style>

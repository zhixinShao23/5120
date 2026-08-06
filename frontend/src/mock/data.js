/**
 * Stand-in data for the City of Melbourne feeds we expect from the backend.
 *
 * Everything here is shaped like the response the API is meant to return, so
 * when the real endpoints land the only change is in `services/api.js` —
 * nothing in the components needs to move.
 */

/** Searchable destinations, used by the origin/destination autocomplete. */
export const PLACES = [
  { id: 'flinders-st', name: 'Flinders Street Station', kind: 'transport', lat: -37.8183, lng: 144.9671 },
  { id: 'fed-square', name: 'Federation Square', kind: 'landmark', lat: -37.8180, lng: 144.9691 },
  { id: 'southern-cross', name: 'Southern Cross Station', kind: 'transport', lat: -37.8183, lng: 144.9525 },
  { id: 'melb-central', name: 'Melbourne Central', kind: 'shopping', lat: -37.8100, lng: 144.9628 },
  { id: 'qv-market', name: 'Queen Victoria Market', kind: 'market', lat: -37.8076, lng: 144.9568 },
  { id: 'state-library', name: 'State Library Victoria', kind: 'culture', lat: -37.8098, lng: 144.9652 },
  { id: 'bourke-mall', name: 'Bourke Street Mall', kind: 'shopping', lat: -37.8136, lng: 144.9646 },
  { id: 'parliament', name: 'Parliament House', kind: 'landmark', lat: -37.8110, lng: 144.9733 },
  { id: 'carlton-gardens', name: 'Carlton Gardens', kind: 'park', lat: -37.8055, lng: 144.9709 },
  { id: 'treasury-gardens', name: 'Treasury Gardens', kind: 'park', lat: -37.8130, lng: 144.9758 },
  { id: 'flagstaff-gardens', name: 'Flagstaff Gardens', kind: 'park', lat: -37.8106, lng: 144.9540 },
  { id: 'rmit', name: 'RMIT University City Campus', kind: 'education', lat: -37.8080, lng: 144.9634 },
  { id: 'unimelb', name: 'University of Melbourne', kind: 'education', lat: -37.7963, lng: 144.9614 },
  { id: 'docklands', name: 'Docklands Waterfront City', kind: 'precinct', lat: -37.8148, lng: 144.9391 },
  { id: 'birrarung-marr', name: 'Birrarung Marr', kind: 'park', lat: -37.8189, lng: 144.9727 },
  { id: 'acmi', name: 'ACMI', kind: 'culture', lat: -37.8177, lng: 144.9687 },
  { id: 'nvg', name: 'NGV International', kind: 'culture', lat: -37.8226, lng: 144.9689 },
  { id: 'melb-museum', name: 'Melbourne Museum', kind: 'culture', lat: -37.8033, lng: 144.9717 },
  { id: 'town-hall', name: 'Melbourne Town Hall', kind: 'landmark', lat: -37.8148, lng: 144.9668 },
  { id: 'sea-life', name: 'SEA LIFE Melbourne Aquarium', kind: 'attraction', lat: -37.8210, lng: 144.9581 },
]

/**
 * Feature 3 — potential landmarks.
 *
 * Places worth going to, each rated for how sensory-demanding it is.
 * `sensoryScore` is 0-100 where lower is calmer, matching the route scale.
 */
export const LANDMARKS = [
  {
    id: 'lm-state-library',
    name: 'State Library Victoria',
    category: 'Culture',
    lat: -37.8098,
    lng: 144.9652,
    sensoryScore: 22,
    quietHours: '9:00–11:00, 16:00–18:00',
    features: ['Quiet reading rooms', 'Soft lighting', 'Free entry', 'Accessible toilets'],
    blurb:
      'The domed reading room stays hushed by convention. Side galleries are the calmest part of the building.',
  },
  {
    id: 'lm-flagstaff',
    name: 'Flagstaff Gardens',
    category: 'Park',
    lat: -37.8106,
    lng: 144.954,
    sensoryScore: 14,
    quietHours: 'All day except 12:00–14:00',
    features: ['Open green space', 'Shaded seating', 'Low foot traffic', 'Away from trams'],
    blurb:
      "The CBD's oldest park, and the least busy. Set back from the arterials so traffic noise drops off sharply.",
  },
  {
    id: 'lm-treasury',
    name: 'Treasury Gardens',
    category: 'Park',
    lat: -37.813,
    lng: 144.9758,
    sensoryScore: 17,
    quietHours: '7:00–11:00, 15:00–17:00',
    features: ['Tree canopy', 'Water feature', 'Wide paths', 'Benches every 40 m'],
    blurb: 'Mature elms cut both glare and street noise. Good decompression stop after Parliament station.',
  },
  {
    id: 'lm-acmi',
    name: 'ACMI',
    category: 'Museum',
    lat: -37.8177,
    lng: 144.9687,
    sensoryScore: 38,
    quietHours: '10:00–12:00 weekdays',
    features: ['Sensory guide available', 'Dimmable exhibits', 'Quiet room on level 1'],
    blurb:
      'Runs relaxed sessions with lower sound levels. The permanent gallery is dark, which suits light sensitivity but not everyone.',
  },
  {
    id: 'lm-birrarung',
    name: 'Birrarung Marr',
    category: 'Park',
    lat: -37.8189,
    lng: 144.9727,
    sensoryScore: 20,
    quietHours: 'Before 10:00, after 16:00',
    features: ['Riverside', 'Step-free paths', 'Open sightlines', 'Escape routes on both sides'],
    blurb:
      'The upper terrace is quiet even when the lower one is not. Avoid during events at the adjacent arena.',
  },
  {
    id: 'lm-immigration',
    name: 'Immigration Museum',
    category: 'Museum',
    lat: -37.8189,
    lng: 144.9601,
    sensoryScore: 25,
    quietHours: '10:00–12:00',
    features: ['Small galleries', 'Seating throughout', 'Predictable layout', 'Courtyard'],
    blurb: 'Rarely crowded on weekday mornings. The courtyard is a reliable low-stimulus retreat.',
  },
  {
    id: 'lm-city-library',
    name: 'City Library, Flinders Lane',
    category: 'Library',
    lat: -37.8156,
    lng: 144.966,
    sensoryScore: 19,
    quietHours: '9:00–11:00',
    features: ['Study booths', 'Quiet floor', 'Free water', 'Central but off the main street'],
    blurb: 'One street back from Collins, which is enough to lose most of the noise.',
  },
  {
    id: 'lm-qv-gardens',
    name: 'Queen Victoria Gardens',
    category: 'Park',
    lat: -37.8244,
    lng: 144.9713,
    sensoryScore: 15,
    quietHours: 'All day',
    features: ['Floral clock', 'Wide lawns', 'Minimal crowds', 'River access'],
    blurb: 'Across the river and away from the grid entirely. The quietest green space within walking distance.',
  },
  {
    id: 'lm-carlton-gardens',
    name: 'Carlton Gardens',
    category: 'Park',
    lat: -37.8055,
    lng: 144.9709,
    sensoryScore: 18,
    quietHours: '7:00–10:00, after 15:00',
    features: ['World Heritage site', 'Fountains', 'Long sightlines', 'Grass and shade'],
    blurb: 'Big enough that you can always find an empty corner, even during museum peak hours.',
  },
  {
    id: 'lm-fitzroy-gardens',
    name: 'Fitzroy Gardens',
    category: 'Park',
    lat: -37.8127,
    lng: 144.9797,
    sensoryScore: 13,
    quietHours: 'All day except weekends 11:00–15:00',
    features: ['Dense canopy', 'Conservatory', 'Quietest measured zone', 'Public toilets'],
    blurb: 'The lowest ambient noise reading anywhere near the CBD. Worth the extra ten minutes of walking.',
  },
  {
    id: 'lm-hosier',
    name: 'Hosier Lane',
    category: 'Street art',
    lat: -37.8164,
    lng: 144.9691,
    sensoryScore: 52,
    quietHours: 'Before 9:00',
    features: ['Narrow', 'Visually intense', 'Busy with tour groups', 'Uneven bluestone'],
    blurb:
      'Included for completeness — visually spectacular but high stimulus and often congested. Go early or skip.',
  },
  {
    id: 'lm-qv-market',
    name: 'Queen Victoria Market',
    category: 'Market',
    lat: -37.8076,
    lng: 144.9568,
    sensoryScore: 71,
    quietHours: 'Tue & Thu from 15:00 (near close)',
    features: ['Very loud', 'Strong smells', 'Dense crowds', 'Covered'],
    blurb:
      'High on every sensory axis. Listed so you can plan around it; the last hour before close is the only calm window.',
  },
]

/** Live weather. Rain and heat both push the sensory-risk score up. */
export const WEATHER = {
  temperatureC: 16,
  condition: 'Partly cloudy',
  icon: 'cloud',
  windKph: 18,
  rainChance: 0.2,
  uvIndex: 3,
}


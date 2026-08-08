# QuietWay — frontend

Sensory-friendly navigation for the City of Melbourne. Vue 3 + Vite + Leaflet.

```bash
npm install
npm run dev      # http://localhost:5173
npm run build
```

No backend or API key is needed to run it. Every network call falls back to a
local mock, so the whole app is clickable today.

## The three deliverables

| # | Feature | Where it lives |
|---|---------|----------------|
| 1 | Live crowd levels on the map | `components/MapView.vue` (crowd layer), `components/LiveStatusCard.vue`, `components/CrowdLegend.vue` |
| 2 | Recommended routes from history + live crowding | `services/routing.js`, `components/DirectionsPanel.vue`, `components/RouteCard.vue` |
| 3 | Potential landmarks | `components/LandmarksPanel.vue`, `mock/data.js` |

## How the sensory-risk score works

Every intersection carries four normalised 0–1 axes — `crowd`, `noise`,
`light`, `smell`. Live sensor readings override the crowd axis; the rest come
from the street model in `mock/cityGrid.js`.

The user's selected needs weight those axes. Unselected axes still count at
0.25 weight, because a silent but packed street is not actually a good route.
An edge then costs:

```
cost = length_in_metres × (1 + aversion × mean_risk_of_its_two_ends)
```

Dijkstra over that cost, run at three `aversion` levels (quietest / balanced /
fastest), produces the route options. Identical paths are deduplicated rather
than shown twice. A route's headline score is its length-weighted mean risk on
a 0–100 scale, lower being calmer.

## Swapping in the real API

`services/api.js` is the only file that touches the network. Each function
tries the endpoint, and returns the mock if it 404s, errors, or times out
(4 s). Point it at the backend with:

```bash
VITE_API_BASE=https://your-backend/api npm run dev
# or leave it unset and use the Vite proxy:
VITE_API_TARGET=http://localhost:8000 npm run dev
```

The contract the backend needs to satisfy:

```
GET  /api/crowd/live      -> { sensors: Sensor[], observedAt: ISO8601 }
GET  /api/weather/current -> Weather
GET  /api/places?q=       -> { places: Place[] }
GET  /api/landmarks       -> { landmarks: Landmark[] }
POST /api/routes/plan     -> { routes: Route[] }
     body: { origin: Place, destination: Place, needs: Record<axis, boolean> }
```

```ts
Sensor   { id, nodeId, name, lat, lng, count, normalised /* 0-1 */,
           level: 'low'|'moderate'|'high'|'severe',
           trend: 'rising'|'steady'|'falling', updatedAt }
Place    { id, name, kind, lat, lng }
Landmark { id, name, category, lat, lng, sensoryScore /* 0-100 */,
           quietHours, features: string[], blurb }
Route    { id, label, accent, coordinates: [lat,lng][], distanceM, durationMin,
           sensoryScore /* 0-100 */,
           breakdown: { crowd, noise, light, smell },  // each 0-100
           warnings: [{ nodeId, name, message, count }],
           steps:    [{ instruction, detail, metres }],
           via, recommended? }
```

If the backend returns routes, the client-side router is bypassed entirely —
`services/routing.js` becomes dead weight and can be deleted. Until then it is
the reference implementation of the scoring model.

## Live re-routing

Sensors are polled every 15 s. Routes are silently re-scored on each poll. If
the user's current route gets more than 8 points worse *and* an option at
least 10 points calmer exists, `AlertBanner` offers the switch rather than
swapping the line underneath them.

## Known gaps

- Routing is confined to the Hoddle grid (`mock/cityGrid.js`), a ~100 m
  accurate model of the CBD. Destinations outside it snap to the nearest
  edge intersection and get a straight walk-in leg.
- Basemap is CARTO/OSM rather than Google, so no API key is required. Swap the
  `TILES` object in `MapView.vue` if you get a Google Maps key.
- `Quiet spots`, `Public transport`, `Toilets` and `Shade` chips are wired to
  layer state but only `Quiet spots` filters anything so far.

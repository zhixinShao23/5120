/**
 * The single seam between the UI and the backend.
 *
 * Every call tries the real endpoint first and falls back to the local
 * routing engine if it is unreachable or errors. That engine
 * (`services/engine/`) is a client-side port of the Python backend
 * (grid.py / scoring.py / crowd.py / routing.py / main.py) — real Hoddle
 * Grid intersections, real pedestrian sensor data, the same crowd-cost
 * model — so the app runs today with no server at all, and moves to
 * whatever the team deploys the moment `VITE_API_BASE` points at it, with
 * no component changes.
 *
 * Expected endpoints (documented here so the backend has a contract to hit):
 *   GET  /api/crowd/live                     -> { sensors: Sensor[], observedAt }
 *   GET  /api/weather/current                -> Weather
 *   GET  /api/places?q=                      -> { places: Place[] }
 *   GET  /api/landmarks                      -> { landmarks: Landmark[] }
 *   POST /api/routes/plan { origin, destination, maxFlow } -> { routes: Route[] }
 */

import { PLACES, LANDMARKS, WEATHER } from '@/mock/data.js'
import { rankRoutes, WALK_SPEED_MPS, flowBand } from './routing.js'
import { matchToRoads } from './realRoads.js'
import * as grid from './engine/grid.js'
import * as localApi from './engine/localApi.js'

// No default: an unset VITE_API_BASE means "no backend deployed yet", and
// request() below skips the attempt entirely rather than firing a request
// that's guaranteed to 404 on every call.
const API_BASE = import.meta.env.VITE_API_BASE ?? null
const REQUEST_TIMEOUT_MS = 4000

/** Tracks whether the real `/api` backend answered, so the UI can say so honestly. */
export const connection = { live: false, lastError: null }

async function request(path, options = {}) {
  if (!API_BASE) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...options,
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    const data = await response.json()
    connection.live = true
    connection.lastError = null
    return data
  } catch (error) {
    connection.live = false
    connection.lastError = error.message
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Previous poll's heatmap points, keyed by sensor id — for trend arrows. */
let previousPoints = new Map()

// ---------------------------------------------------------------------------
// Route shape adapter — the engine speaks the Python backend's vocabulary
// (`distance_m`, `peak_density`, `steps: [{from, to, street, density}]`);
// the Vue components speak the UI's (`distanceM`, `peakFlow`,
// `steps: [{instruction, detail, metres}]`). This is the seam between them.
// ---------------------------------------------------------------------------

const PRESET_META = {
  quiet: { label: 'Quietest', accent: '#12805c' },
  calm: { label: 'Balanced', accent: '#1a73e8' },
  fast: { label: 'Fastest', accent: '#e8710a' },
}

/** Consecutive same-street blocks collapse into one turn-by-turn instruction. */
function stepsFromBlocks(blockSteps) {
  const out = []
  for (const s of blockSteps) {
    const previous = out[out.length - 1]
    if (previous && previous.detail === s.street) {
      previous.metres += s.length_m
    } else {
      out.push({
        instruction: out.length === 0 ? `Head along ${s.street}` : `Continue onto ${s.street}`,
        detail: s.street,
        metres: s.length_m,
      })
    }
  }
  return out.map((s) => ({ ...s, metres: Math.round(s.metres) }))
}

/** Every measured block over the user's limit becomes a warning. */
function warningsFromBlocks(blockSteps, limit) {
  return blockSteps
    .filter((s) => s.measured && s.density > limit)
    .map((s) => ({
      nodeId: s.to,
      name: s.to,
      message: `${s.density} people/min on ${s.street} — over your limit`,
      count: s.density,
    }))
}

/** "via Little Collins St & Russell St" — the streets that define the route. */
function viaFromBlocks(blockSteps) {
  const streets = []
  for (const s of blockSteps) {
    if (streets[streets.length - 1] !== s.street) streets.push(s.street)
  }
  return streets.slice(0, 3).join(' & ')
}

/** Turn points where the street changes — for snapping onto real roads. */
function waypointsFromRoute(route, endpoints) {
  const waypoints = [endpoints.origin ?? { lat: route.coords[0][0], lng: route.coords[0][1] }]
  for (let i = 1; i < route.steps.length; i++) {
    if (route.steps[i].street !== route.steps[i - 1].street) {
      const [lat, lng] = route.coords[i]
      waypoints.push({ lat, lng })
    }
  }
  const [lastLat, lastLng] = route.coords[route.coords.length - 1]
  waypoints.push(endpoints.destination ?? { lat: lastLat, lng: lastLng })
  return waypoints
}

function toUiRoute(route, endpoints, maxFlow, assumedDensity) {
  const meta = PRESET_META[route.id] ?? { label: route.id, accent: '#5f6368' }

  const coordinates = [...route.coords]
  if (endpoints.origin) coordinates.unshift([endpoints.origin.lat, endpoints.origin.lng])
  if (endpoints.destination) coordinates.push([endpoints.destination.lat, endpoints.destination.lng])

  const peakStep = route.peak_density != null
    ? route.steps.find((s) => s.density === route.peak_density)
    : null

  // A route with no sensor coverage at all has peak_density === null. That
  // must NOT read as "0 people/min" — an unmeasured street is not a
  // confirmed-quiet one, and treating it as such let a fully-unverified
  // detour outrank a genuinely-measured, genuinely-compliant route. Fall
  // back to the same conservative "what the city is typically doing right
  // now" estimate the pathfinder itself used to price unmeasured blocks.
  const verified = route.coverage_pct > 0
  const peakFlow = route.peak_density ?? assumedDensity

  return {
    id: route.id,
    presetId: route.id,
    label: meta.label,
    accent: meta.accent,
    coordinates,
    waypoints: waypointsFromRoute(route, endpoints),
    distanceM: route.total_m,
    durationMin: route.total_minutes,
    peakFlow,
    peakAt: peakStep?.street ?? null,
    meanFlow: route.mean_density ?? peakFlow,
    verified,
    warnings: warningsFromBlocks(route.steps, maxFlow),
    steps: stepsFromBlocks(route.steps),
    via: viaFromBlocks(route.steps),
  }
}

/** Drop routes whose real-road geometry substantially duplicates a calmer one. */
function dedupeOverlapping(routes) {
  const kept = []
  for (const route of [...routes].sort((a, b) => a.meanFlow - b.meanFlow)) {
    const signature = new Set(
      route.coordinates.map(([lat, lng]) => `${lat.toFixed(4)},${lng.toFixed(4)}`),
    )
    const duplicate = kept.some((other) => {
      let shared = 0
      for (const point of signature) if (other._signature.has(point)) shared++
      return shared / Math.min(signature.size, other._signature.size) > 0.8
    })
    if (!duplicate) {
      route._signature = signature
      kept.push(route)
    }
  }
  for (const route of kept) delete route._signature
  return kept
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Feature 1 — live crowd levels for the map. */
export async function fetchLiveCrowd() {
  const data = await request('/crowd/live')
  if (data?.sensors) {
    return { sensors: data.sensors, observedAt: data.observedAt ?? new Date().toISOString(), live: connection.live }
  }

  const now = new Date()
  const hm = await localApi.heatmap()
  const sensors = hm.data.points.map((p) => {
    const prevNormalised = previousPoints.get(p.id)?.intensity ?? p.intensity ?? 0
    const normalised = p.intensity ?? 0
    const delta = normalised - prevNormalised
    return {
      id: `sensor-${p.id}`,
      nodeId: grid.nearestNode(p.lat, p.lng),
      name: p.name,
      lat: p.lat,
      lng: p.lng,
      count: p.density,
      normalised,
      level: flowBand(p.density).id,
      trend: delta > 0.015 ? 'rising' : delta < -0.015 ? 'falling' : 'steady',
      updatedAt: now.toISOString(),
    }
  })
  previousPoints = new Map(hm.data.points.map((p) => [p.id, p]))

  // No real `/api` backend to report through `request()`, but the engine's
  // own crowd source (live government feed vs. cached snapshot) is the
  // thing "Live City of Melbourne data" is actually meant to reflect.
  connection.live = hm.meta.source === 'live'
  connection.lastError = null

  return { sensors, observedAt: now.toISOString(), live: connection.live }
}

export async function fetchWeather() {
  const data = await request('/weather/current')
  return data ?? WEATHER
}

/** Autocomplete over known destinations. */
export async function searchPlaces(query) {
  const trimmed = query.trim()
  if (!trimmed) return []

  const data = await request(`/places?q=${encodeURIComponent(trimmed)}`)
  if (data?.places) return data.places

  const needle = trimmed.toLowerCase()
  return PLACES.filter((p) => p.name.toLowerCase().includes(needle))
    // Prefix matches are far more likely to be what was meant.
    .sort((a, b) => {
      const aPrefix = a.name.toLowerCase().startsWith(needle) ? 0 : 1
      const bPrefix = b.name.toLowerCase().startsWith(needle) ? 0 : 1
      return aPrefix - bPrefix || a.name.localeCompare(b.name)
    })
    .slice(0, 6)
}

/** Feature 3 — potential landmarks, calmest first. */
export async function fetchLandmarks() {
  const data = await request('/landmarks')
  const landmarks = data?.landmarks ?? LANDMARKS
  return [...landmarks].sort((a, b) => a.sensoryScore - b.sensoryScore)
}

/** Sensory refuges — parks, quiet indoor spaces, etc. from the council POI dataset. */
export async function fetchRefuges() {
  const data = await request('/refuges')
  if (data?.refuges) return data.refuges

  const result = await localApi.allRefuges()
  return result.data.refuges.map((r) => ({
    id: r.poiId,
    name: r.name,
    category: r.subTheme,
    lat: r.lat,
    lng: r.lng,
    noiseLevel: r.noiseLevel,
  }))
}

/**
 * Feature 2 — recommended routes.
 *
 * `maxFlow` is the user's comfort ceiling in people per minute, passed
 * straight through to the engine as its `tolerance` — no point on the
 * recommended route should exceed it.
 */
export async function planRoute({ origin, destination, maxFlow }) {
  const data = await request('/routes/plan', {
    method: 'POST',
    body: JSON.stringify({ origin, destination, maxFlow }),
  })
  if (data?.routes) return data.routes

  if (!origin || !destination) return []

  let result
  try {
    result = await localApi.route({
      origin: { lat: origin.lat, lng: origin.lng },
      destination: { lat: destination.lat, lng: destination.lng },
      tolerance: maxFlow,
    })
  } catch (error) {
    console.error('local routing engine failed', error)
    return []
  }

  const endpoints = { origin, destination }
  const assumedDensity = result.meta.assumed_density
  const routes = result.data.routes.map((r) => toUiRoute(r, endpoints, maxFlow, assumedDensity))

  // The grid decides which streets to take; the real road network decides
  // what that actually looks like. Best-effort per route — a failure keeps
  // the grid geometry rather than losing the option.
  await Promise.all(
    routes.map(async (route) => {
      const matched = await matchToRoads(route.waypoints)
      if (!matched) return
      route.coordinates = matched.coordinates
      route.distanceM = matched.distanceM
      route.durationMin = Math.max(1, Math.round(matched.distanceM / WALK_SPEED_MPS / 60))
      if (matched.steps.length) route.steps = matched.steps
    }),
  )

  // Distinct grid corridors can collapse onto the same real streets. Showing
  // the same road twice as two "options" is dishonest — keep the calmer copy.
  // Re-rank afterwards: durations changed, so "fastest under the limit" must
  // be re-decided against the real distances.
  return rankRoutes(dedupeOverlapping(routes), maxFlow)
}

/**
 * Feature 2 — label a map tap. Close to a real intersection, name it after
 * that; otherwise it's just a dropped pin.
 */
export function describeTap(lat, lng) {
  const [node, metres] = grid.snap(lat, lng)
  const name = metres < 120 ? `Near ${node.replace('/', ' & ')}` : 'Dropped pin'
  return { id: `pin-${lat.toFixed(5)},${lng.toFixed(5)}`, name, kind: 'pin', lat, lng }
}

export { PLACES }

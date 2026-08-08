/**
 * The single seam between the UI and the backend.
 *
 * Every call tries the real endpoint first and falls back to the local mock
 * if it is unreachable or errors. That means the app runs today with no
 * backend at all, and starts using live City of Melbourne data the moment the
 * team points `VITE_API_BASE` at a running service — with no component
 * changes.
 *
 * Expected endpoints (documented here so the backend has a contract to hit):
 *   GET  /api/crowd/live                     -> { sensors: Sensor[], observedAt }
 *   GET  /api/weather/current                -> Weather
 *   GET  /api/places?q=                      -> { places: Place[] }
 *   GET  /api/landmarks                      -> { landmarks: Landmark[] }
 *   POST /api/routes/plan { origin, destination, maxFlow } -> { routes: Route[] }
 */

import { buildGraph, nearestNode } from '@/mock/cityGrid.js'
import { PLACES, LANDMARKS, WEATHER } from '@/mock/data.js'
import { planRoutes, rankRoutes, WALK_SPEED_MPS, MAX_FLOW } from './routing.js'
import { matchToRoads } from './realRoads.js'

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'
const REQUEST_TIMEOUT_MS = 4000

/** Shared graph instance — building it is cheap but not free. */
export const graph = buildGraph()

/** Tracks whether we are serving real data, so the UI can say so honestly. */
export const connection = { live: false, lastError: null }

async function request(path, options = {}) {
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

// ---------------------------------------------------------------------------
// Mock generators
// ---------------------------------------------------------------------------

/**
 * Deterministic per-sensor jitter. Using a hash rather than Math.random keeps
 * a sensor's character stable between polls — a quiet corner stays quiet —
 * while the time term still makes the numbers move.
 */
function jitter(seed, bucket) {
  let h = 2166136261
  const key = `${seed}:${bucket}`
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

/** Foot traffic follows a two-peak weekday curve: commute in, lunch, commute out. */
function timeOfDayFactor(date) {
  const hour = date.getHours() + date.getMinutes() / 60
  const peak = (centre, spread, height) =>
    height * Math.exp(-((hour - centre) ** 2) / (2 * spread ** 2))

  const weekend = date.getDay() === 0 || date.getDay() === 6
  if (weekend) {
    return 0.25 + peak(13, 3.0, 0.6)
  }
  return 0.15 + peak(8.5, 1.1, 0.75) + peak(12.8, 1.4, 0.65) + peak(17.5, 1.2, 0.9)
}

/** Only a subset of intersections carry a pedestrian counter, as in reality. */
const SENSOR_NODES = [
  '5:0', '5:1', '5:2', '5:3', '5:4', // Swanston St spine
  '4:0', '4:2', '4:4', // Elizabeth St
  '3:1', '3:3', // Queen St
  '2:1', '2:3', // William St
  '0:0', '0:2', // Spencer / Southern Cross
  '1:2', // King St
  '6:2', '6:4', // Russell St
  '7:1', '7:3', // Exhibition St
  '8:0', '8:2', '8:4', // Spring St
  '5:5', '3:5', // Victoria St
]

function levelFor(normalised) {
  if (normalised < 0.3) return 'low'
  if (normalised < 0.55) return 'moderate'
  if (normalised < 0.75) return 'high'
  return 'severe'
}

function mockSensors(now = new Date()) {
  const tod = timeOfDayFactor(now)
  // Re-roll jitter every 30 s so the map visibly breathes without thrashing.
  const bucket = Math.floor(now.getTime() / 30000)

  return SENSOR_NODES.map((id) => {
    const node = graph.nodes.get(id)
    const wobble = (jitter(id, bucket) - 0.5) * 0.18
    const prevWobble = (jitter(id, bucket - 1) - 0.5) * 0.18

    const normalised = Math.min(1, Math.max(0.02, node.busyness * tod + wobble))
    const previous = Math.min(1, Math.max(0.02, node.busyness * tod + prevWobble))

    // Counts are people per MINUTE, scaled so a fully saturated sensor
    // reads MAX_FLOW (200/min) — the same ceiling as the comfort slider.
    const count = Math.round(normalised * MAX_FLOW)

    return {
      id: `sensor-${id}`,
      nodeId: id,
      name: node.name,
      lat: node.lat,
      lng: node.lng,
      count,
      normalised,
      level: levelFor(normalised),
      trend: normalised - previous > 0.015 ? 'rising' : normalised - previous < -0.015 ? 'falling' : 'steady',
      updatedAt: now.toISOString(),
    }
  })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Feature 1 — live crowd levels for the map. */
export async function fetchLiveCrowd() {
  const data = await request('/crowd/live')
  const sensors = data?.sensors ?? mockSensors()
  return {
    sensors,
    observedAt: data?.observedAt ?? new Date().toISOString(),
    live: connection.live,
  }
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

/**
 * Feature 2 — recommended routes.
 *
 * `maxFlow` is the user's comfort ceiling in people per minute: no point on
 * the recommended route should exceed it.
 */
export async function planRoute({ origin, destination, maxFlow, sensors }) {
  const data = await request('/routes/plan', {
    method: 'POST',
    body: JSON.stringify({ origin, destination, maxFlow }),
  })
  if (data?.routes) return data.routes

  const startNode = nearestNode(graph, origin)
  const endNode = nearestNode(graph, destination)
  if (!startNode || !endNode || startNode.id === endNode.id) return []

  const live = new Map((sensors ?? []).map((s) => [s.nodeId, s]))
  const routes = planRoutes({
    startId: startNode.id,
    endId: endNode.id,
    live,
    graph,
    endpoints: { origin, destination },
    maxFlow,
  })

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

export { PLACES }

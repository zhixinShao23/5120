/**
 * Crowd-aware walking router.
 *
 * The backend is expected to own this eventually. Until it does, the same
 * model runs client-side so the UI can be built and demoed against something
 * that behaves correctly rather than against canned polylines.
 *
 * The user states one number: the most people per minute they are comfortable
 * passing through. Routing then has two jobs:
 *
 *   1. Prefer streets with less foot traffic in general.
 *   2. Treat any point over the user's limit as somewhere to route around —
 *      and if that is impossible, say so honestly rather than pretending.
 */

import { buildGraph, haversine, parseNodeId, NS_STREETS, EW_STREETS } from '@/mock/cityGrid.js'

export const WALK_SPEED_MPS = 1.35 // ~4.9 km/h, an unhurried pace

/**
 * A fully saturated sensor reads this many people per minute. The comfort
 * slider shares the same ceiling so its right-hand end means "any crowd".
 */
export const MAX_FLOW = 200

export const DEFAULT_MAX_FLOW = 100

/**
 * The hard ceiling on detour length. Even when no route fits the user's
 * limit and we fall back to "least crowded", we never recommend a route more
 * than this much longer than the fastest one — a route nobody would actually
 * walk is not a recommendation.
 */
const ABSOLUTE_MAX_DETOUR = 0.8

/**
 * Candidate generators, not user-facing choices: each aversion level pulls
 * the search toward a different corridor so the selector below has genuinely
 * different options to judge against the user's limit.
 *
 * Accents must all read as "selected" on the map, since unselected routes are
 * drawn in grey.
 */
const PRESETS = [
  { id: 'quietest', label: 'Quietest', aversion: 4.0, accent: '#12805c' },
  { id: 'balanced', label: 'Balanced', aversion: 1.4, accent: '#1a73e8' },
  { id: 'fastest', label: 'Fastest', aversion: 0.35, accent: '#e8710a' },
]

/**
 * People per minute passing a node right now. Live sensor reading where one
 * exists; otherwise an estimate from the node's structural busyness, damped
 * because the baseline describes peak character rather than a typical minute.
 */
export function nodeFlow(node, live) {
  const sensor = live?.get(node.id)
  if (sensor) return sensor.count
  return Math.round(node.busyness * MAX_FLOW * 0.65)
}

/** Colour band for a people-per-minute figure. Matches the map legend. */
export function flowBand(flow) {
  if (flow < 60) return { id: 'quiet', label: 'Quiet', colour: '#12805c' }
  if (flow < 110) return { id: 'moderate', label: 'Moderate', colour: '#b8860b' }
  if (flow < 150) return { id: 'busy', label: 'Busy', colour: '#e8710a' }
  return { id: 'packed', label: 'Very busy', colour: '#d93025' }
}

/**
 * Dijkstra with flow-aware edge costs. Streets get more expensive as they get
 * busier, and severely so past the user's limit — the router will take a real
 * detour to avoid an over-limit point, but a soft penalty (rather than a hard
 * wall) means it can still produce a route when everything is over.
 */
function shortestPath(graph, startId, endId, live, aversion, limit, penalised) {
  const dist = new Map([[startId, 0]])
  const prev = new Map()
  const visited = new Set()
  // A binary heap would be the right call at city scale; at 54 nodes a linear
  // scan is faster than the bookkeeping.
  const queue = new Set([startId])

  while (queue.size) {
    let current = null
    let currentDist = Infinity
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity
      if (d < currentDist) {
        currentDist = d
        current = id
      }
    }
    if (current === null) break

    queue.delete(current)
    visited.add(current)
    if (current === endId) break

    for (const neighbourId of graph.edges.get(current) ?? []) {
      if (visited.has(neighbourId)) continue

      const a = graph.nodes.get(current)
      const b = graph.nodes.get(neighbourId)
      const metres = haversine(a, b)
      const flow = (nodeFlow(a, live) + nodeFlow(b, live)) / 2

      let cost = metres * (1 + aversion * (flow / MAX_FLOW))
      if (flow > limit) cost *= 4
      if (penalised?.has(neighbourId)) cost *= 2.5

      const candidate = currentDist + cost
      if (candidate < (dist.get(neighbourId) ?? Infinity)) {
        dist.set(neighbourId, candidate)
        prev.set(neighbourId, current)
        queue.add(neighbourId)
      }
    }
  }

  if (!prev.has(endId) && startId !== endId) return null

  const path = [endId]
  let cursor = endId
  while (cursor !== startId) {
    cursor = prev.get(cursor)
    if (cursor === undefined) return null
    path.unshift(cursor)
  }
  return path.map((id) => graph.nodes.get(id))
}

/** Turn-by-turn directions derived from the grid axis each leg travels along. */
function buildSteps(path) {
  if (path.length < 2) return []

  const steps = []
  let runStart = 0

  const axisOf = (a, b) => (a.u === b.u ? 'ns' : 'ew')
  const streetOf = (a, b) => (a.u === b.u ? NS_STREETS[a.u] : EW_STREETS[a.v])

  for (let i = 1; i < path.length; i++) {
    const sameAxis =
      i + 1 < path.length &&
      axisOf(path[i - 1], path[i]) === axisOf(path[i], path[i + 1]) &&
      streetOf(path[i - 1], path[i]) === streetOf(path[i], path[i + 1])
    if (sameAxis) continue

    const from = path[runStart]
    const to = path[i]
    const street = streetOf(path[runStart], path[runStart + 1])
    const metres = Math.round(haversine(from, to))

    let heading
    if (from.u === to.u) heading = to.v > from.v ? 'north' : 'south'
    else heading = to.u > from.u ? 'east' : 'west'

    steps.push({
      instruction: `Head ${heading} on ${street}`,
      detail: to.name,
      metres,
    })
    runStart = i
  }

  return steps
}

/**
 * Score a completed path and attach the metadata the UI renders.
 *
 * `endpoints` are the real origin/destination coordinates. The graph only
 * knows about intersections, so without stitching these on the drawn line
 * stops short of the pin the user actually dropped.
 */
function describe(path, live, preset, endpoints = {}, limit) {
  let metres = 0
  for (let i = 1; i < path.length; i++) metres += haversine(path[i - 1], path[i])

  // The crowding profile of the walk: its worst point and its typical level.
  let peakFlow = 0
  let peakAt = null
  let flowSum = 0
  for (const node of path) {
    const flow = nodeFlow(node, live)
    flowSum += flow
    if (flow > peakFlow) {
      peakFlow = flow
      peakAt = node.name
    }
  }
  const meanFlow = Math.round(flowSum / path.length)

  // Every point the user asked not to be taken through.
  const warnings = path
    .filter((n) => nodeFlow(n, live) > limit)
    .map((n) => ({
      nodeId: n.id,
      name: n.name,
      message: `${nodeFlow(n, live)} people/min at ${n.name} — over your limit`,
      count: nodeFlow(n, live),
    }))

  // Walk-in and walk-out legs from the actual pins to the road network.
  const coordinates = path.map((n) => [n.lat, n.lng])
  if (endpoints.origin) {
    coordinates.unshift([endpoints.origin.lat, endpoints.origin.lng])
    metres += haversine(endpoints.origin, path[0])
  }
  if (endpoints.destination) {
    coordinates.push([endpoints.destination.lat, endpoints.destination.lng])
    metres += haversine(path[path.length - 1], endpoints.destination)
  }

  // The corridor's turn points, for snapping onto the real road network.
  const waypoints = []
  waypoints.push(endpoints.origin ?? path[0])
  for (let i = 1; i < path.length - 1; i++) {
    const axisBefore = path[i - 1].u === path[i].u ? 'ns' : 'ew'
    const axisAfter = path[i].u === path[i + 1].u ? 'ns' : 'ew'
    if (axisBefore !== axisAfter) waypoints.push(path[i])
  }
  waypoints.push(endpoints.destination ?? path[path.length - 1])

  // Identity is the corridor itself, not the preset that found it. Presets
  // re-run against live data and can land on different streets each time; a
  // user's chosen route must stay chosen because it is the same *road*.
  let hash = 2166136261
  const pathKey = path.map((n) => n.id).join('>')
  for (let i = 0; i < pathKey.length; i++) {
    hash ^= pathKey.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }

  return {
    id: `r${(hash >>> 0).toString(36)}`,
    presetId: preset.id,
    label: preset.label,
    accent: preset.accent,
    coordinates,
    waypoints: waypoints.map((p) => ({ lat: p.lat, lng: p.lng })),
    distanceM: Math.round(metres),
    durationMin: Math.max(1, Math.round(metres / WALK_SPEED_MPS / 60)),
    peakFlow,
    peakAt,
    meanFlow,
    warnings,
    steps: buildSteps(path),
    via: summariseVia(path),
  }
}

/** "via Little Collins St & Russell St" — the streets that define the route. */
function summariseVia(path) {
  const streets = []
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]
    const b = path[i]
    const street = a.u === b.u ? NS_STREETS[a.u] : EW_STREETS[a.v]
    if (streets[streets.length - 1] !== street) streets.push(street)
  }
  return streets.slice(0, 3).join(' & ')
}

/**
 * Plan route options between two graph nodes, then pick what to recommend
 * against the user's crowd limit.
 */
export function planRoutes({ startId, endId, live, graph, endpoints, maxFlow = DEFAULT_MAX_FLOW }) {
  const g = graph ?? buildGraph()
  const seen = new Set()
  const routes = []
  const covered = new Set()

  const accept = (path, preset) => {
    const signature = path.map((n) => n.id).join('>')
    if (seen.has(signature)) return false
    seen.add(signature)
    for (const node of path.slice(1, -1)) covered.add(node.id)
    routes.push(describe(path, live, preset, endpoints, maxFlow))
    return true
  }

  for (const preset of PRESETS) {
    const path = shortestPath(g, startId, endId, live, preset.aversion, maxFlow)
    if (path) accept(path, preset)
  }

  // The presets often collapse onto one street. Force distinct candidates by
  // penalising ground already covered and re-running.
  const EXTRA = [
    { id: 'alternative', label: 'Alternative', aversion: 1.4, accent: '#8430ce' },
    { id: 'alternative-2', label: 'Alternative', aversion: 3.2, accent: '#0b8043' },
  ]
  for (const preset of EXTRA) {
    if (routes.length >= 3) break
    const path = shortestPath(g, startId, endId, live, preset.aversion, maxFlow, covered)
    if (path) accept(path, preset)
  }

  return rankRoutes(routes, maxFlow)
}

/**
 * Decide the recommendation.
 *
 * Simple, honest policy:
 *   - Among routes whose busiest point stays under the limit, recommend the
 *     fastest. The user gave us a ceiling, not a request for silence — once
 *     under it, extra quiet is not worth extra walking.
 *   - If nothing stays under the limit, recommend the lowest-peak route that
 *     is not an absurd detour, and say plainly that the limit can't be met.
 */
export function rankRoutes(routes, limit) {
  if (routes.length === 0) return routes

  const fastest = routes.reduce((a, b) => (b.durationMin < a.durationMin ? b : a))

  for (const route of routes) {
    route.underLimit = route.peakFlow <= limit
    route.recommended = false
    route.reason = null
    route.excludedBecause = null
  }

  const eligible = routes.filter((r) => r.underLimit)

  let winner
  let limitMet = eligible.length > 0
  if (limitMet) {
    winner = eligible.reduce((a, b) =>
      b.durationMin < a.durationMin || (b.durationMin === a.durationMin && b.peakFlow < a.peakFlow)
        ? b
        : a,
    )
  } else {
    // Nothing fits the limit. Least-crowded wins, within a sane detour.
    const walkable = routes.filter(
      (r) => r.durationMin <= fastest.durationMin * (1 + ABSOLUTE_MAX_DETOUR),
    )
    winner = walkable.reduce((a, b) => (b.peakFlow < a.peakFlow ? b : a))
  }

  winner.recommended = true

  const extraMin = winner.durationMin - fastest.durationMin
  if (!limitMet) {
    winner.reason = `No route stays under ${limit} people/min right now — this one has the lowest peak (${winner.peakFlow}/min at ${winner.peakAt}).`
  } else if (winner === fastest) {
    winner.reason = `Fastest option, and its busiest point is ${winner.peakFlow} people/min — under your ${limit} limit.`
  } else {
    winner.reason = `${extraMin} min longer than the fastest route, but stays under your limit (peak ${winner.peakFlow}/min vs ${fastest.peakFlow}/min).`
  }

  for (const route of routes) {
    if (route === winner) continue
    if (!route.underLimit) {
      route.excludedBecause = `peaks at ${route.peakFlow} people/min at ${route.peakAt} — over your ${limit} limit`
    }
  }

  // Recommended first, then within-limit options by speed, then the rest by
  // how badly they miss the limit.
  routes.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
    if (a.underLimit !== b.underLimit) return a.underLimit ? -1 : 1
    return a.underLimit ? a.durationMin - b.durationMin : a.peakFlow - b.peakFlow
  })

  return routes
}

/**
 * Coarse band for a 0-100 sensory score. Still used by the landmarks list,
 * whose calmness ratings are curated on a 0-100 scale.
 */
export function scoreBand(score) {
  if (score < 30) return { id: 'calm', label: 'Calm', colour: '#12805c' }
  if (score < 50) return { id: 'moderate', label: 'Moderate', colour: '#b8860b' }
  if (score < 70) return { id: 'busy', label: 'Busy', colour: '#e8710a' }
  return { id: 'overwhelming', label: 'Overwhelming', colour: '#d93025' }
}

export { PRESETS, parseNodeId }

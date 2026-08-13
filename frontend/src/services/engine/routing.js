/**
 * Routing engine — port of backend/routing.py.
 *
 * Turns a scored graph into comparable routes: the calmest path, the
 * lowest-peak path, and the shortest one. Contains NO scoring logic — a
 * threshold or a weight belongs in scoring.js.
 *
 * The graph is DIRECTED: every block is added twice, once per direction of
 * travel, because walking a street one way and back can cost different
 * amounts once counterflow is in play.
 */

import * as grid from './grid.js'
import * as scoring from './scoring.js'

// Average walking pace, metres per minute — used only for the time estimate.
const WALK_M_PER_MIN = 80.0

// In the lowest-peak search, an unmeasured block costs this many times more
// than a measured one of the same length, steering ties toward blocks we can
// actually vouch for.
const UNVERIFIED_TIEBREAK = 2.5

// --------------------------------------------------------------------------
// Generic Dijkstra — the grid is small (under 200 directed edges), so a
// linear scan beats the bookkeeping of a real binary heap.
// --------------------------------------------------------------------------

function dijkstra(adj, source, target, weightFn) {
  if (source === target) return [source]
  if (!adj.has(source) || !adj.has(target)) return null

  const dist = new Map([[source, 0]])
  const prev = new Map()
  const visited = new Set()
  const queue = new Set([source])

  while (queue.size) {
    let current = null
    let currentDist = Infinity
    for (const id of queue) {
      const d = dist.get(id) ?? Infinity
      if (d < currentDist) { currentDist = d; current = id }
    }
    if (current === null) break

    queue.delete(current)
    visited.add(current)
    if (current === target) break

    for (const [next, data] of adj.get(current) ?? []) {
      if (visited.has(next)) continue
      const candidate = currentDist + weightFn(data)
      if (candidate < (dist.get(next) ?? Infinity)) {
        dist.set(next, candidate)
        prev.set(next, current)
        queue.add(next)
      }
    }
  }

  if (!prev.has(target)) return null
  const path = [target]
  let cursor = target
  while (cursor !== source) {
    cursor = prev.get(cursor)
    if (cursor === undefined) return null
    path.unshift(cursor)
  }
  return path
}

function samePath(a, b) {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

// --------------------------------------------------------------------------
// Graph construction
// --------------------------------------------------------------------------

/** Directed copy of the street grid, weighted by sensory cost. */
function scoredGraph(tolerance, loads) {
  const g = new Map()
  for (const name of grid.NODES.keys()) g.set(name, new Map())
  for (const [a, b] of grid.EDGES) {
    for (const [u, v] of [[a, b], [b, a]]) {
      g.get(u).set(v, {
        sensory: scoring.edgeCost(u, v, tolerance, loads),
        length: grid.edgeLength(u, v),
      })
    }
  }
  return g
}

/**
 * Bottleneck shortest path: minimise the WORST block, not the total. A route
 * is RATED by its peak, so this offers the path a sensory-sensitive walker
 * would actually want — binary search over observed densities, keeping only
 * blocks at or below the candidate ceiling and asking whether a path exists.
 */
function lowestPeakPath(origin, destination, loads) {
  const assumed = scoring.assumedDensity(loads)
  const levelSet = new Set([assumed])
  for (const [u, v] of grid.EDGES) {
    const d = scoring.blockDensity(u, v, loads)
    if (d != null) levelSet.add(d)
  }
  const levels = [...levelSet].sort((a, b) => a - b)
  if (levels.length === 0) return null

  let best = null
  let lo = 0
  let hi = levels.length - 1
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const ceiling = levels[mid]

    const h2 = new Map()
    const ensure = (n) => { if (!h2.has(n)) h2.set(n, new Map()) }
    for (const [u, v] of grid.EDGES) {
      let d = scoring.blockDensity(u, v, loads)
      const unknown = d == null
      if (unknown) d = assumed
      if (d <= ceiling) {
        // Among paths tying on the ceiling, prefer VERIFIED blocks — without
        // this the search returns whichever path is shortest, which tends
        // to be a chain of unmeasured blocks we cannot vouch for.
        const w = grid.edgeLength(u, v) * (unknown ? UNVERIFIED_TIEBREAK : 1.0)
        ensure(u); ensure(v)
        h2.get(u).set(v, w)
        h2.get(v).set(u, w)
      }
    }

    const path = h2.has(origin) && h2.has(destination)
      ? dijkstra(h2, origin, destination, (w) => w)
      : null
    if (path) { best = path; hi = mid - 1 } else { lo = mid + 1 }
  }
  return best
}

// --------------------------------------------------------------------------
// Summarising a path
// --------------------------------------------------------------------------

function summarise(path, routeId, tolerance, loads, predicted) {
  const blockPairs = []
  for (let i = 0; i < path.length - 1; i++) blockPairs.push([path[i], path[i + 1]])
  const densities = blockPairs.map(([u, v]) => scoring.blockDensity(u, v, loads))
  const measured = densities.filter((d) => d != null)

  const totalM = blockPairs.reduce((s, [u, v]) => s + grid.edgeLength(u, v), 0)
  // A route's rating is driven by its WORST block, not its average — one
  // bad corridor is what ruins a trip for a sensory-sensitive walker.
  const peak = measured.length ? Math.max(...measured) : null

  return {
    id: routeId,
    path,
    coords: grid.coords(path),
    blocks: blockPairs.length,
    distance_m: Math.round(totalM),
    minutes: Math.round(totalM / WALK_M_PER_MIN),
    rating: scoring.rate(peak, predicted),
    peak_density: peak,
    mean_density: measured.length ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : null,
    coverage_pct: blockPairs.length ? Math.round((100 * measured.length) / blockPairs.length) : 0,
    steps: blockPairs.map(([u, v], i) => ({
      from: u,
      to: v,
      street: grid.edgeStreet(u, v),
      length_m: grid.edgeLength(u, v),
      density: densities[i],
      rating: scoring.rate(densities[i], predicted),
      measured: densities[i] != null,
    })),
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Ways to join the street network from a start/end spec. A named
 * intersection has exactly one, costing nothing. A projected position has
 * two — either end of the block the person is standing on — and the router
 * picks whichever gives the better trip overall.
 */
function entryOptions(spec) {
  if (typeof spec === 'string') return [[spec, 0.0, null]]

  const out = []
  for (const [end, along] of [['u', 'to_u_m'], ['v', 'to_v_m']]) {
    const node = spec[end]
    const walk = spec.offset_m + spec[along]
    out.push([node, walk, {
      to_node: node,
      metres: Math.round(walk * 10) / 10,
      minutes: Math.round(walk / WALK_M_PER_MIN),
      offset_m: spec.offset_m,
      along_block_m: spec[along],
      on_block: `${spec.u} -> ${spec.v}`,
      point: spec.point,
    }])
  }
  return out
}

/** Price the walk-in on the same scale as a block, using the assumed density. */
function accessCost(metres, tolerance, loads) {
  if (metres <= 0) return 0.0
  const assumed = Math.min(scoring.assumedDensity(loads), scoring.DENSITY_CEILING)
  return metres * (1.0 + (scoring.W_DENSITY * assumed) / Math.max(tolerance, 1))
}

/**
 * Routes between two intersections: calmest, lowest-peak, and shortest.
 * `origin`/`destination` are either a node name (string) or a projected
 * spec from `grid.projectToEdge`. Throws for unknown intersection names or
 * when no route exists.
 */
export function plan(origin, destination, tolerance, loads, source = 'unknown') {
  const predicted = source === 'predicted'
  for (const spec of [origin, destination]) {
    if (typeof spec === 'string' && !grid.NODES.has(spec)) {
      throw new Error(`unknown intersection: ${spec}`)
    }
  }

  const oOpts = entryOptions(origin)
  const dOpts = entryOptions(destination)
  const g = scoredGraph(tolerance, loads)

  // Try every combination of entry and exit corner, keep the cheapest
  // overall — this is why projecting beats snapping: the nearer corner is
  // not always the one that gives the better walk.
  let best = null
  for (const [oNode, oWalk, oLeg] of oOpts) {
    for (const [dNode, dWalk, dLeg] of dOpts) {
      if (oNode === dNode) continue
      const p = dijkstra(g, oNode, dNode, (d) => d.sensory)
      if (!p) continue
      let total = 0
      for (let i = 0; i < p.length - 1; i++) total += g.get(p[i]).get(p[i + 1]).sensory
      total += accessCost(oWalk, tolerance, loads) + accessCost(dWalk, tolerance, loads)
      if (best === null || total < best.total) best = { total, oNode, dNode, oLeg, dLeg, oWalk, dWalk }
    }
  }

  if (best === null) throw new Error('no route between those points')
  const { oNode: originNode, dNode: destNode, oLeg, dLeg, oWalk, dWalk } = best
  if (originNode === destNode) throw new Error('origin and destination are the same')

  const calmPath = dijkstra(g, originNode, destNode, (d) => d.sensory)
  const fastPath = dijkstra(g, originNode, destNode, (d) => d.length)
  const quietPath = lowestPeakPath(originNode, destNode, loads)

  const calm = summarise(calmPath, 'calm', tolerance, loads, predicted)
  const routes = [calm]
  const seen = [calmPath]

  // Lowest-peak route: what the RATING actually measures, and often
  // different from the lowest-total route.
  if (quietPath && !seen.some((p) => samePath(p, quietPath))) {
    routes.push(summarise(quietPath, 'quiet', tolerance, loads, predicted))
    seen.push(quietPath)
  }
  // Only offer the fast route when it is genuinely a different option.
  if (!seen.some((p) => samePath(p, fastPath))) {
    routes.push(summarise(fastPath, 'fast', tolerance, loads, predicted))
  }

  // Confidence degrades when much of the route is unmeasured or the crowd
  // data is a cached fallback.
  const cov = calm.coverage_pct
  let confidence
  if (source === 'cached' || cov < 40) confidence = 'low'
  else if (cov < 70) confidence = 'medium'
  else confidence = 'high'

  const accessM = oWalk + dWalk
  for (const r of routes) {
    r.access_m = Math.round(accessM)
    r.total_m = Math.round(r.distance_m + accessM)
    r.total_minutes = Math.round(r.total_m / WALK_M_PER_MIN)
  }

  return {
    data: { routes, access: { start: oLeg, end: dLeg } },
    meta: {
      source,
      confidence,
      basis: predicted
        ? `${cov}% of the calm route has historical baseline coverage`
        : `${cov}% of the calm route has live sensor coverage`,
      coverage_pct: cov,
      // What an unmeasured block is assumed to cost — the same number the
      // pathfinder itself used to price them. A route with 0% sensor
      // coverage has a `peak_density` of null; callers should treat this as
      // the honest stand-in for "unknown, don't assume it's quiet."
      assumed_density: Math.round(scoring.assumedDensity(loads)),
      tolerance,
      attribution: 'City of Melbourne, CC BY 4.0',
    },
  }
}

/** Every intersection, for origin/destination pickers. */
export function nodeList() {
  return [...grid.NODES.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, [lat, lng]]) => ({ id, lat, lng }))
}

/** Every block the router knows about, with its current reading. */
export function blocks(loads) {
  const out = []
  for (const [u, v] of grid.EDGES) {
    const density = scoring.blockDensity(u, v, loads)
    const nearby = grid.sensorsForEdge(u, v)
    const street = grid.edgeStreet(u, v)
    out.push({
      from: u,
      to: v,
      street,
      little: grid.LITTLE_NAMES.has(street),
      coords: [grid.NODES.get(u), grid.NODES.get(v)],
      length_m: grid.edgeLength(u, v),
      density,
      rating: scoring.rate(density),
      // Every sensor within range, not just the one that won `density` —
      // scoring.busiestSensor() picks the worst reading among these.
      sensors: nearby.map((s) => s.sensorId),
      sensor_names: nearby.map((s) => grid.SENSORS.get(s.sensorId)?.description),
    })
  }
  return {
    data: { blocks: out },
    meta: {
      blocks: out.length,
      measured: out.filter((b) => b.density != null).length,
      little_streets: grid.INCLUDE_LITTLE_STREETS,
      match_radius_m: grid.SENSOR_RADIUS_M,
    },
  }
}

/**
 * Current density at every reporting sensor, normalised for the client.
 * `predicted` swaps in the historical-baseline-calibrated scale for both
 * `intensity` (marker size) and `rating` — otherwise every predicted sensor
 * normalises to near-zero against the live ceiling and reads "low"
 * regardless of how busy it actually is relative to other predicted hours.
 */
export function heatmap(loads, predicted = false) {
  const points = []
  for (const [sid, s] of grid.SENSORS) {
    const load = loads.get(sid)
    if (load == null) continue
    points.push({
      id: sid,
      lat: s.lat,
      lng: s.lng,
      density: load.total,
      d1: load.d1,
      d2: load.d2,
      intensity: scoring.normalise(load.total, predicted),
      rating: scoring.rate(load.total, predicted),
      name: s.description,
    })
  }
  return {
    data: { points },
    meta: {
      reporting: points.length,
      sensors: grid.SENSORS.size,
      attribution: 'City of Melbourne, CC BY 4.0',
    },
  }
}

export function findRefuges({ lat = null, lng = null, node = null, radiusM = 800.0 } = {}) {
  let rlat = lat
  let rlng = lng
  if (node && grid.NODES.has(node)) [rlat, rlng] = grid.NODES.get(node)
  else if (rlat == null || rlng == null) [rlat, rlng] = [-37.8136, 144.9631]

  const refuges = grid.findNearbyRefuges(rlat, rlng, radiusM)
  return { data: { refuges }, meta: { count: refuges.length, radius_m: radiusM } }
}

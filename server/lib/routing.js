/**
 * Routing engine — server-side counterpart to
 * frontend/src/services/engine/routing.js. Same Dijkstra, same bottleneck
 * search, same route summaries — the only difference is `state` (built from
 * Postgres by grid.js's loadGridState) is passed explicitly instead of read
 * off module-level singletons, since this module has no "page load" moment
 * to build them at.
 */

import * as grid from './grid.js'
import * as scoring from './scoring.js'

const WALK_M_PER_MIN = 80.0
const UNVERIFIED_TIEBREAK = 2.5

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

/** Directed copy of the street grid, weighted by sensory cost. */
function scoredGraph(state, tolerance, loads) {
  const g = new Map()
  for (const name of state.nodes.keys()) g.set(name, new Map())
  for (const [a, b] of state.edges) {
    for (const [u, v] of [[a, b], [b, a]]) {
      g.get(u).set(v, {
        sensory: scoring.edgeCost(state, u, v, tolerance, loads),
        length: grid.edgeLength(state, u, v),
      })
    }
  }
  return g
}

/** Bottleneck shortest path: minimise the WORST block, not the total. */
function lowestPeakPath(state, origin, destination, loads) {
  const assumed = scoring.assumedDensity(loads)
  const levelSet = new Set([assumed])
  for (const [u, v] of state.edges) {
    const d = scoring.blockDensity(state, u, v, loads)
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
    for (const [u, v] of state.edges) {
      let d = scoring.blockDensity(state, u, v, loads)
      const unknown = d == null
      if (unknown) d = assumed
      if (d <= ceiling) {
        const w = grid.edgeLength(state, u, v) * (unknown ? UNVERIFIED_TIEBREAK : 1.0)
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

function summarise(state, path, routeId, tolerance, loads) {
  const blockPairs = []
  for (let i = 0; i < path.length - 1; i++) blockPairs.push([path[i], path[i + 1]])
  const densities = blockPairs.map(([u, v]) => scoring.blockDensity(state, u, v, loads))
  const measured = densities.filter((d) => d != null)

  const totalM = blockPairs.reduce((s, [u, v]) => s + grid.edgeLength(state, u, v), 0)
  const peak = measured.length ? Math.max(...measured) : null

  return {
    id: routeId,
    path,
    coords: grid.coords(state, path),
    blocks: blockPairs.length,
    distance_m: Math.round(totalM),
    minutes: Math.round(totalM / WALK_M_PER_MIN),
    rating: scoring.rate(peak),
    peak_density: peak,
    mean_density: measured.length ? Math.round(measured.reduce((a, b) => a + b, 0) / measured.length) : null,
    coverage_pct: blockPairs.length ? Math.round((100 * measured.length) / blockPairs.length) : 0,
    steps: blockPairs.map(([u, v], i) => ({
      from: u,
      to: v,
      street: grid.edgeStreet(state, u, v),
      length_m: grid.edgeLength(state, u, v),
      density: densities[i],
      rating: scoring.rate(densities[i]),
      measured: densities[i] != null,
    })),
  }
}

/** Entry points from a start/end spec — a named node, or a projected block position. */
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

function accessCost(tolerance, loads, metres) {
  if (metres <= 0) return 0.0
  const assumed = Math.min(scoring.assumedDensity(loads), scoring.DENSITY_CEILING)
  return metres * (1.0 + (scoring.W_DENSITY * assumed) / Math.max(tolerance, 1))
}

/**
 * Routes between two intersections: calmest, lowest-peak, and shortest.
 * `origin`/`destination` are either a node name (string) or a projected
 * spec from grid.projectToEdge(state, lat, lng).
 */
export function plan(state, origin, destination, tolerance, loads, source = 'unknown') {
  for (const spec of [origin, destination]) {
    if (typeof spec === 'string' && !state.nodes.has(spec)) {
      throw new Error(`unknown intersection: ${spec}`)
    }
  }

  const oOpts = entryOptions(origin)
  const dOpts = entryOptions(destination)
  const g = scoredGraph(state, tolerance, loads)

  let best = null
  for (const [oNode, oWalk, oLeg] of oOpts) {
    for (const [dNode, dWalk, dLeg] of dOpts) {
      if (oNode === dNode) continue
      const p = dijkstra(g, oNode, dNode, (d) => d.sensory)
      if (!p) continue
      let total = 0
      for (let i = 0; i < p.length - 1; i++) total += g.get(p[i]).get(p[i + 1]).sensory
      total += accessCost(tolerance, loads, oWalk) + accessCost(tolerance, loads, dWalk)
      if (best === null || total < best.total) best = { total, oNode, dNode, oLeg, dLeg, oWalk, dWalk }
    }
  }

  if (best === null) throw new Error('no route between those points')
  const { oNode: originNode, dNode: destNode, oLeg, dLeg, oWalk, dWalk } = best
  if (originNode === destNode) throw new Error('origin and destination are the same')

  const calmPath = dijkstra(g, originNode, destNode, (d) => d.sensory)
  const fastPath = dijkstra(g, originNode, destNode, (d) => d.length)
  const quietPath = lowestPeakPath(state, originNode, destNode, loads)

  const calm = summarise(state, calmPath, 'calm', tolerance, loads)
  const routes = [calm]
  const seen = [calmPath]

  if (quietPath && !seen.some((p) => samePath(p, quietPath))) {
    routes.push(summarise(state, quietPath, 'quiet', tolerance, loads))
    seen.push(quietPath)
  }
  if (!seen.some((p) => samePath(p, fastPath))) {
    routes.push(summarise(state, fastPath, 'fast', tolerance, loads))
  }

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
      basis: `${cov}% of the calm route has live sensor coverage`,
      coverage_pct: cov,
      assumed_density: Math.round(scoring.assumedDensity(loads)),
      tolerance,
      attribution: 'City of Melbourne, CC BY 4.0',
    },
  }
}

export function nodeList(state) {
  return [...state.nodes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, [lat, lng]]) => ({ id, lat, lng }))
}

export function blocks(state, loads) {
  const out = []
  for (const [u, v] of state.edges) {
    const density = scoring.blockDensity(state, u, v, loads)
    const nearby = grid.sensorsForEdge(state, u, v)
    const street = grid.edgeStreet(state, u, v)
    out.push({
      from: u,
      to: v,
      street,
      little: state.littleNames.has(street),
      coords: [state.nodes.get(u), state.nodes.get(v)],
      length_m: grid.edgeLength(state, u, v),
      density,
      rating: scoring.rate(density),
      sensors: nearby.map((s) => s.sensorId),
      sensor_names: nearby.map((s) => state.sensors.get(s.sensorId)?.description),
    })
  }
  return {
    data: { blocks: out },
    meta: {
      blocks: out.length,
      measured: out.filter((b) => b.density != null).length,
    },
  }
}

export function heatmap(state, loads) {
  const points = []
  for (const [sid, s] of state.sensors) {
    const load = loads.get(sid)
    if (load == null) continue
    points.push({
      id: sid,
      lat: s.lat,
      lng: s.lng,
      density: load.total,
      d1: load.d1,
      d2: load.d2,
      intensity: scoring.normalise(load.total),
      rating: scoring.rate(load.total),
      name: s.description,
    })
  }
  return {
    data: { points },
    meta: {
      reporting: points.length,
      sensors: state.sensors.size,
      attribution: 'City of Melbourne, CC BY 4.0',
    },
  }
}

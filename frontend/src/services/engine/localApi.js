/**
 * Local API layer — port of the relevant slice of backend/main.py.
 *
 * Thin: every function validates its input, calls into routing.js, and
 * returns the result. No routing logic, no scoring logic, no thresholds.
 * Runs entirely client-side — this is the "mock API" role main.py played,
 * minus the network hop.
 */

import * as grid from './grid.js'
import * as crowd from './crowd.js'
import * as routing from './routing.js'

// --------------------------------------------------------------------------
// Crowd data cache
//
// crowd.getAllLoads() can make several API calls to the council feed, which
// only refreshes every 15 minutes — so hitting it on every plan would be
// slow and rude. One fetch serves every call for the cache window.
// --------------------------------------------------------------------------

const CACHE_SECONDS = 120

const _cache = { loads: null, source: 'unknown', at: 0 }

/** [loads, source, ageSeconds] — refreshes only when the cache is stale. */
async function currentLoads() {
  const age = (Date.now() - _cache.at) / 1000
  if (_cache.loads === null || age > CACHE_SECONDS) {
    _cache.loads = await crowd.getAllLoads()
    _cache.source = crowd.source()
    _cache.at = Date.now()
    return [_cache.loads, _cache.source, 0]
  }
  return [_cache.loads, _cache.source, Math.floor(age)]
}

// --------------------------------------------------------------------------
// A named intersection, or a projection onto the block the person is
// standing beside. Projecting rather than snapping keeps the walk-in as a
// real leg of the trip instead of silently discarding up to half a block.
// --------------------------------------------------------------------------

function resolve(point, label) {
  if (point?.node) {
    if (!grid.NODES.has(point.node)) throw new Error(`unknown intersection: ${point.node}`)
    return point.node
  }
  if (point?.lat == null || point?.lng == null) {
    throw new Error(`${label} needs either a node or lat and lng`)
  }
  const proj = grid.projectToEdge(point.lat, point.lng)
  if (proj == null) throw new Error(`${label} is outside the mapped area`)
  proj.tapped = [point.lat, point.lng]
  return proj
}

// --------------------------------------------------------------------------
// Endpoints
// --------------------------------------------------------------------------

/** Every intersection, for the pickers. */
export async function nodes() {
  return { data: { nodes: routing.nodeList() }, meta: { count: grid.NODES.size } }
}

/** Calm, quiet and fast routes between two points. `tolerance` is people/min. */
export async function route({ origin, destination, tolerance = 80 }) {
  const [loads, source, age] = await currentLoads()
  const originSpec = resolve(origin, 'origin')
  const destinationSpec = resolve(destination, 'destination')

  const result = routing.plan(originSpec, destinationSpec, tolerance, loads, source)
  result.meta.data_age_seconds = age

  for (const [end, spec] of [['start', originSpec], ['end', destinationSpec]]) {
    const leg = result.data.access[end]
    if (leg && typeof spec === 'object' && spec.tapped) leg.tapped = spec.tapped
  }
  return result
}

/** Current density at every reporting sensor. */
export async function heatmap() {
  const [loads, source, age] = await currentLoads()
  const result = routing.heatmap(loads)
  result.meta.source = source
  result.meta.data_age_seconds = age
  return result
}

/** Every block the router knows, with its current reading. */
export async function blocks() {
  const [loads, source, age] = await currentLoads()
  const result = routing.blocks(loads)
  result.meta.source = source
  result.meta.data_age_seconds = age
  return result
}

/** Feed freshness and grid coverage. */
export async function health() {
  const [loads, source, age] = await currentLoads()
  const covered = grid.EDGES.filter(([u, v]) => grid.sensorsForEdge(u, v).length > 0).length
  return {
    status: loads.size ? 'ok' : 'degraded',
    source,
    data_age_seconds: age,
    sensors_reporting: loads.size,
    sensors_known: grid.SENSORS.size,
    blocks: grid.EDGES.length,
    blocks_with_sensor: covered,
    attribution: 'City of Melbourne, CC BY 4.0',
  }
}

/** Nearby sensory refuge locations, if the POI data is available. */
export async function refuges({ node, lat, lng, radiusM = 800.0 } = {}) {
  return routing.findRefuges({ node, lat, lng, radiusM })
}

/** Every sensory refuge in the mapped area, for drawing the whole layer. */
export async function allRefuges() {
  const list = grid.allRefuges()
  return { data: { refuges: list }, meta: { count: list.length } }
}

/** The cached crowd loads Map, for debug tooling that needs raw per-sensor counts. */
export async function debugLoads() {
  const [loads] = await currentLoads()
  return loads
}

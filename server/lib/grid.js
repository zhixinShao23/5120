/**
 * Location engine — server-side counterpart to
 * frontend/src/services/engine/grid.js.
 *
 * The frontend version fetches CSVs over a relative URL at module load,
 * which only works in a browser (see route-audit.js's comment on that).
 * This version builds the identical in-memory graph shape from Postgres
 * rows instead, via loadGridState(pool) — called once at server startup,
 * mirroring the frontend's "build once, never inside a request handler"
 * discipline.
 *
 * Nodes are STREET INTERSECTIONS, edges are the block of street between two
 * adjacent intersections — every block is added twice (once per direction)
 * so routing.js's directed graph can walk either way at a possibly
 * different cost.
 */

import { haversineM, distanceToSegmentM, bearingDeg } from './geo.js'

export function edgeKey(u, v) {
  return u < v ? `${u} ${v}` : `${v} ${u}`
}

/**
 * Load intersections, blocks, sensors and block_sensors from Postgres and
 * assemble them into the same shape grid.js keeps in memory: a node map, an
 * undirected adjacency map, an edge list, a sensor map and a
 * block -> nearby-sensors map.
 */
export async function loadGridState(pool) {
  const [{ rows: intersectionRows }, { rows: blockRows }, { rows: sensorRows }, { rows: blockSensorRows }] =
    await Promise.all([
      pool.query('SELECT id, street_ns, street_ew, lat, lng FROM intersections'),
      pool.query(
        'SELECT id, from_intersection, to_intersection, street_name, is_little_street, length_m, bearing_deg FROM blocks',
      ),
      pool.query(
        "SELECT id, description, lat, lng, bearing_d1, bearing_d2, status FROM sensors WHERE status = 'A'",
      ),
      pool.query('SELECT block_id, sensor_id, distance_m FROM block_sensors ORDER BY block_id, distance_m'),
    ])

  const nodes = new Map()
  for (const r of intersectionRows) nodes.set(r.id, [Number(r.lat), Number(r.lng)])

  const graph = new Map()
  for (const name of nodes.keys()) graph.set(name, new Map())

  const edgeList = []
  const littleNames = new Set()
  const blockEndpoints = new Map() // block_id -> [u, v], for joining block_sensors

  for (const r of blockRows) {
    const u = r.from_intersection
    const v = r.to_intersection
    const data = {
      length_m: Number(r.length_m),
      bearing: Number(r.bearing_deg),
      street: r.street_name,
    }
    graph.get(u).set(v, data)
    graph.get(v).set(u, data)
    edgeList.push([u, v])
    blockEndpoints.set(String(r.id), [u, v])
    if (r.is_little_street) littleNames.add(r.street_name)
  }

  const sensors = new Map()
  for (const r of sensorRows) {
    sensors.set(r.id, {
      locationId: r.id,
      description: r.description,
      lat: Number(r.lat),
      lng: Number(r.lng),
      bearingD1: r.bearing_d1 == null ? null : Number(r.bearing_d1),
      bearingD2: r.bearing_d2 == null ? null : Number(r.bearing_d2),
    })
  }

  const edgeSensors = new Map()
  for (const [u, v] of edgeList) edgeSensors.set(edgeKey(u, v), [])
  for (const r of blockSensorRows) {
    const endpoints = blockEndpoints.get(String(r.block_id))
    if (!endpoints) continue // stale block_sensors row pointing at a deleted block
    const key = edgeKey(...endpoints)
    edgeSensors.get(key).push({ sensorId: r.sensor_id, distanceM: Number(r.distance_m) })
  }

  return { nodes, graph, edges: edgeList, sensors, edgeSensors, littleNames }
}

export function edgeLength(state, u, v) {
  return state.graph.get(u).get(v).length_m
}

export function edgeStreet(state, u, v) {
  return state.graph.get(u).get(v).street
}

/** Compass heading walking FROM u TO v. */
export function edgeBearing(state, u, v) {
  const [alat, alng] = state.nodes.get(u)
  const [blat, blng] = state.nodes.get(v)
  return bearingDeg(alat, alng, blat, blng)
}

/** Every sensor within range of this block, nearest first. Empty = UNMEASURED. */
export function sensorsForEdge(state, u, v) {
  return state.edgeSensors.get(edgeKey(u, v)) ?? []
}

export function sensorForEdge(state, u, v) {
  const near = sensorsForEdge(state, u, v)
  return near.length ? near[0].sensorId : null
}

/** Snap an arbitrary map position to the closest intersection. */
export function nearestNode(state, lat, lng) {
  let best = null
  let bestDist = Infinity
  for (const [name, [nlat, nlng]] of state.nodes) {
    const d = haversineM(lat, lng, nlat, nlng)
    if (d < bestDist) { bestDist = d; best = name }
  }
  return best
}

/**
 * Project a position onto the nearest BLOCK, not the nearest corner, so a
 * walk starts where the person is actually standing beside the street.
 */
export function projectToEdge(state, lat, lng) {
  if (state.nodes.size === 0) return null

  const lat0 = (lat * Math.PI) / 180
  const kx = Math.cos(lat0) * 111_320.0
  const ky = 111_320.0
  const toXy = (a, b) => [(b - lng) * kx, (a - lat) * ky]

  let best = null
  for (const [u, v] of state.edges) {
    const [ax, ay] = toXy(...state.nodes.get(u))
    const [bx, by] = toXy(...state.nodes.get(v))
    const dx = bx - ax
    const dy = by - ay
    const seg2 = dx * dx + dy * dy
    if (seg2 === 0) continue
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / seg2))
    const px = ax + t * dx
    const py = ay + t * dy
    const d = Math.sqrt(px * px + py * py)
    if (best === null || d < best[0]) best = [d, u, v, t]
  }

  const [d, u, v, t] = best
  const length = edgeLength(state, u, v)
  const [au, av0] = state.nodes.get(u)
  const [bu, bv0] = state.nodes.get(v)
  return {
    u, v,
    point: [Math.round((au + t * (bu - au)) * 1e6) / 1e6, Math.round((av0 + t * (bv0 - av0)) * 1e6) / 1e6],
    offset_m: Math.round(d * 10) / 10,
    to_u_m: Math.round(t * length * 10) / 10,
    to_v_m: Math.round((1 - t) * length * 10) / 10,
  }
}

export function snap(state, lat, lng) {
  const node = nearestNode(state, lat, lng)
  const [nlat, nlng] = state.nodes.get(node)
  return [node, Math.round(haversineM(lat, lng, nlat, nlng) * 10) / 10]
}

export function distanceToBlock(state, lat, lng, u, v) {
  const [aLat, aLng] = state.nodes.get(u)
  const [bLat, bLng] = state.nodes.get(v)
  return distanceToSegmentM(lat, lng, aLat, aLng, bLat, bLng)
}

/** Intersection names -> [lat, lng] pairs, ready for a polyline. */
export function coords(state, path) {
  return path.map((n) => state.nodes.get(n))
}

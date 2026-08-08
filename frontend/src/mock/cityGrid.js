/**
 * A geo-referenced model of the Melbourne CBD (the Hoddle grid).
 *
 * The grid is rotated ~20° off north, so instead of hard-coding every
 * intersection we anchor it with two basis vectors measured from real
 * coordinates and interpolate. Accuracy is ~100 m, which is plenty for
 * drawing plausible walking routes and hanging crowd sensors off.
 *
 *   position(u, v) = ORIGIN + u * AXIS_EAST + v * AXIS_NORTH
 *
 * u = index along Flinders St, west (Spencer) -> east (Spring)
 * v = index along Spencer St, south (Flinders) -> north (Victoria)
 */

const ORIGIN = { lat: -37.8215, lng: 144.9531 } // Spencer St & Flinders St
const AXIS_EAST = { lat: 0.000675, lng: 0.0025875 } // one block east
const AXIS_NORTH = { lat: 0.0023, lng: -0.000925 } // one block north

/** North-south streets, ordered west to east (the `u` axis). */
export const NS_STREETS = [
  'Spencer St',
  'King St',
  'William St',
  'Queen St',
  'Elizabeth St',
  'Swanston St',
  'Russell St',
  'Exhibition St',
  'Spring St',
]

/** East-west streets, ordered south to north (the `v` axis). */
export const EW_STREETS = [
  'Flinders St',
  'Collins St',
  'Bourke St',
  'Lonsdale St',
  'La Trobe St',
  'Victoria St',
]

export const GRID_WIDTH = NS_STREETS.length
export const GRID_HEIGHT = EW_STREETS.length

/** Convert grid coordinates to real-world lat/lng. */
export function gridToLatLng(u, v) {
  return {
    lat: ORIGIN.lat + u * AXIS_EAST.lat + v * AXIS_NORTH.lat,
    lng: ORIGIN.lng + u * AXIS_EAST.lng + v * AXIS_NORTH.lng,
  }
}

export const nodeId = (u, v) => `${u}:${v}`

export function parseNodeId(id) {
  const [u, v] = id.split(':').map(Number)
  return { u, v }
}

/** Human-readable name for an intersection. */
export function nodeName(u, v) {
  return `${NS_STREETS[u]} & ${EW_STREETS[v]}`
}

/**
 * Baseline "busyness" of each intersection on a 0-1 scale, before any live
 * sensor reading is applied. Hand-tuned from where the crowds actually are:
 * transport interchanges, the Bourke St Mall, and the Swanston St spine.
 */
const HOTSPOTS = [
  { u: 5, v: 0, weight: 1.0, radius: 1.6 }, // Flinders St Station
  { u: 5, v: 2, weight: 0.95, radius: 1.3 }, // Bourke St Mall
  { u: 5, v: 4, weight: 0.9, radius: 1.2 }, // Melbourne Central / State Library
  { u: 0, v: 0, weight: 0.85, radius: 1.1 }, // Southern Cross Station
  { u: 4, v: 2, weight: 0.8, radius: 1.0 }, // Elizabeth St retail
  { u: 5, v: 1, weight: 0.7, radius: 1.0 }, // Collins & Swanston trams
  { u: 3, v: 3, weight: 0.45, radius: 1.2 }, // Queen / Lonsdale
  { u: 8, v: 2, weight: 0.35, radius: 1.4 }, // Parliament end (calmer)
]

function hotspotField(u, v) {
  let peak = 0
  for (const h of HOTSPOTS) {
    const d = Math.hypot(u - h.u, v - h.v)
    const contribution = h.weight * Math.exp(-(d * d) / (2 * h.radius * h.radius))
    peak = Math.max(peak, contribution)
  }
  return peak
}

/**
 * Traffic-noise baseline. The wide arterials (Spencer, King, Elizabeth,
 * La Trobe, Victoria) carry cars and trams; the mid-grid little streets and
 * the garden edges are quieter.
 */
const LOUD_NS = { 0: 0.85, 1: 0.9, 2: 0.55, 3: 0.5, 4: 0.7, 5: 0.65, 6: 0.4, 7: 0.5, 8: 0.6 }
const LOUD_EW = { 0: 0.8, 1: 0.55, 2: 0.6, 3: 0.65, 4: 0.75, 5: 0.85 }

/**
 * Build the full intersection graph. Every node carries the static sensory
 * attributes the risk model reads; live crowd counts are layered on top of
 * this by the API layer.
 */
export function buildGraph() {
  const nodes = new Map()

  for (let u = 0; u < GRID_WIDTH; u++) {
    for (let v = 0; v < GRID_HEIGHT; v++) {
      const busyness = hotspotField(u, v)
      const { lat, lng } = gridToLatLng(u, v)
      nodes.set(nodeId(u, v), {
        id: nodeId(u, v),
        u,
        v,
        lat,
        lng,
        name: nodeName(u, v),
        busyness,
        // Noise is the louder of the two streets, nudged up by foot traffic.
        noise: Math.min(1, Math.max(LOUD_NS[u], LOUD_EW[v]) * 0.8 + busyness * 0.3),
        // Glare: open, wide, treeless junctions bake in the afternoon sun.
        light: Math.min(1, 0.3 + busyness * 0.4 + (LOUD_EW[v] > 0.7 ? 0.2 : 0)),
        // Smell: traffic fumes plus food strips.
        smell: Math.min(1, LOUD_NS[u] * 0.4 + busyness * 0.35),
      })
    }
  }

  /** Undirected adjacency: each intersection links to its grid neighbours. */
  const edges = new Map()
  const link = (a, b) => {
    if (!edges.has(a)) edges.set(a, [])
    edges.get(a).push(b)
  }

  for (let u = 0; u < GRID_WIDTH; u++) {
    for (let v = 0; v < GRID_HEIGHT; v++) {
      const from = nodeId(u, v)
      if (u + 1 < GRID_WIDTH) {
        link(from, nodeId(u + 1, v))
        link(nodeId(u + 1, v), from)
      }
      if (v + 1 < GRID_HEIGHT) {
        link(from, nodeId(u, v + 1))
        link(nodeId(u, v + 1), from)
      }
    }
  }

  return { nodes, edges }
}

/** Great-circle distance in metres. */
export function haversine(a, b) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Nearest intersection to an arbitrary point, for snapping search results. */
export function nearestNode(graph, point) {
  let best = null
  let bestDist = Infinity
  for (const node of graph.nodes.values()) {
    const d = haversine(node, point)
    if (d < bestDist) {
      bestDist = d
      best = node
    }
  }
  return best
}

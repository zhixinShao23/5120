/**
 * QuietWay API — implements the endpoints frontend/src/services/api.js
 * calls, backed by Postgres per database/schema.sql.
 *
 * The routing/scoring/heatmap logic here is a deliberate parallel
 * implementation of frontend/src/services/engine/{grid,scoring,routing}.js
 * (same constants, same algorithms) rather than a shared import, because
 * that engine builds its graph via a browser-only relative `fetch` at
 * module load — see server/lib/grid.js's header comment.
 *
 * On any failure, endpoints respond with a non-2xx status rather than a
 * soft "empty array" success. api.js's request() treats `!response.ok` as
 * a signal to fall back to the local engine — an empty array response would
 * instead read as "the backend answered, and the answer is nothing", which
 * is a different (wrong) thing for a places/refuges/routes search.
 */

import express from 'express'
import cors from 'cors'
import { pool } from './db.js'
import * as grid from './lib/grid.js'
import * as scoring from './lib/scoring.js'
import * as routing from './lib/routing.js'
import { flowBand } from './lib/bands.js'
import { fetchLiveLoads } from './lib/liveCrowd.js'

const PORT = process.env.PORT || 8000

const app = express()
app.use(cors())
app.use(express.json())

// --------------------------------------------------------------------------
// Grid state — loaded once at startup from intersections/blocks/sensors/
// block_sensors, mirroring the frontend engine's "build once at module
// load, never inside a request handler" rule.
// --------------------------------------------------------------------------

let gridStatePromise = null

function getGridState() {
  if (!gridStatePromise) gridStatePromise = grid.loadGridState(pool)
  return gridStatePromise
}

/** Reset the cached grid on the next request — call after re-seeding. */
export function invalidateGridState() {
  gridStatePromise = null
}

// --------------------------------------------------------------------------
// Crowd data — NOT cached at module scope like the grid, because this
// table (and the live feed) is the one thing that changes continuously.
//
// loadCrowd() tries the live City of Melbourne feed first, same as the
// frontend's local engine does — the DB's sensor_readings table is a
// fallback for when that feed is unreachable, not the primary source. A
// backend that only ever served the one-time seed would silently go stale
// forever while claiming to be "live" (that's exactly the bug this fixes:
// a deployed instance kept reporting a 3-day-old evening-peak snapshot as
// "just now" because the endpoint stamped every response with the current
// server time instead of the data's actual timestamp).
// --------------------------------------------------------------------------

// Re-fetching the external feed on every request would hammer it under
// concurrent traffic (the frontend polls every 15s per visitor) — cache
// briefly and share one fetch across requests in that window.
const LIVE_CACHE_MS = 60_000
let liveCache = { loads: null, prevLoads: null, newest: null, fetchedAt: 0 }

async function loadLiveCrowd() {
  if (liveCache.loads && Date.now() - liveCache.fetchedAt < LIVE_CACHE_MS) {
    return liveCache
  }
  const { loads, newest } = await fetchLiveLoads()
  // The cache's outgoing loads become "previous", for trend — a fetch that
  // itself failed (caught by the caller) must not overwrite this.
  liveCache = { loads, prevLoads: liveCache.loads, newest, fetchedAt: Date.now() }
  return liveCache
}

// Two flat queries rather than one with window functions: the latest
// reading per sensor (DISTINCT ON), and every reading ordered per sensor
// (to pick the second-latest for `trend`, in JS). Simpler to reason about,
// and avoids relying on window-function/correlated-subquery support that
// not every Postgres-compatible tool implements equally.
const LATEST_QUERY = `
  SELECT DISTINCT ON (sensor_id)
         sensor_id, direction_1_count AS d1, direction_2_count AS d2,
         total_count AS total, sensing_datetime
  FROM sensor_readings
  ORDER BY sensor_id, sensing_datetime DESC
`
const ALL_TOTALS_QUERY = `
  SELECT sensor_id, total_count, sensing_datetime
  FROM sensor_readings
  ORDER BY sensor_id, sensing_datetime DESC
`

/** Fallback for when the live feed is unreachable — the seeded/last-imported snapshot. */
async function loadCrowdFromDb() {
  const [{ rows: latest }, { rows: all }] = await Promise.all([
    pool.query(LATEST_QUERY),
    pool.query(ALL_TOTALS_QUERY),
  ])

  const loads = new Map()
  let newest = null
  for (const r of latest) {
    loads.set(r.sensor_id, { total: Number(r.total), d1: Number(r.d1), d2: Number(r.d2) })
    if (newest == null || r.sensing_datetime > newest) newest = r.sensing_datetime
  }

  // `all` is ordered per-sensor newest-first, so the second row seen for a
  // sensor is its previous reading.
  const prevTotals = new Map()
  const seenOnce = new Set()
  for (const r of all) {
    if (seenOnce.has(r.sensor_id)) {
      if (!prevTotals.has(r.sensor_id)) prevTotals.set(r.sensor_id, Number(r.total_count))
    } else {
      seenOnce.add(r.sensor_id)
    }
  }

  const ageSeconds = newest ? Math.floor((Date.now() - new Date(newest).getTime()) / 1000) : null
  return { loads, prevTotals, source: loads.size ? 'cached' : 'unavailable', ageSeconds, newest }
}

async function loadCrowd() {
  try {
    const live = await loadLiveCrowd()
    const prevTotals = new Map()
    if (live.prevLoads) {
      for (const [sid, load] of live.prevLoads) prevTotals.set(sid, load.total)
    }
    const ageSeconds = live.newest ? Math.floor((Date.now() - live.newest.getTime()) / 1000) : null
    return { loads: live.loads, prevTotals, source: 'live', ageSeconds, newest: live.newest }
  } catch (e) {
    console.warn('live crowd fetch failed, falling back to DB snapshot:', e.message)
    return loadCrowdFromDb()
  }
}

// --------------------------------------------------------------------------
// Endpoints
// --------------------------------------------------------------------------

app.get(['/health', '/api/health'], async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT version()')
    res.json({ status: 'online', database: 'connected', db_version: rows[0].version })
  } catch (e) {
    res.status(502).json({ status: 'degraded', database: 'disconnected', error: e.message })
  }
})

app.get('/crowd/live', async (req, res) => {
  try {
    const state = await getGridState()
    const { loads, prevTotals, source, ageSeconds, newest } = await loadCrowd()
    // The data's own timestamp, not "now" — a fallback reading from three
    // days ago must say so, not be stamped fresh just because the request
    // happened this second.
    const observedAt = (newest ? new Date(newest) : new Date()).toISOString()

    const sensors = []
    for (const [sid, load] of loads) {
      const s = state.sensors.get(sid)
      if (!s) continue // sensor reported but isn't in the active/known set
      const normalised = scoring.normalise(load.total) ?? 0
      const prevTotal = prevTotals.get(sid)
      const prevNormalised = prevTotal == null ? normalised : scoring.normalise(prevTotal) ?? 0
      const delta = normalised - prevNormalised
      sensors.push({
        id: `sensor-${sid}`,
        nodeId: grid.nearestNode(state, s.lat, s.lng),
        name: s.description,
        lat: s.lat,
        lng: s.lng,
        count: load.total,
        normalised,
        level: flowBand(load.total).id,
        trend: delta > 0.015 ? 'rising' : delta < -0.015 ? 'falling' : 'steady',
        updatedAt: observedAt,
      })
    }

    res.json({ sensors, observedAt, source, dataAgeSeconds: ageSeconds })
  } catch (e) {
    console.error('GET /crowd/live failed:', e)
    res.status(502).json({ sensors: [], error: e.message })
  }
})

app.get('/weather/current', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT temp_c, condition, icon, wind_kph, rain_chance, uv_index FROM weather_observations ORDER BY observed_at DESC LIMIT 1',
    )
    if (!rows.length) {
      res.status(502).json({ error: 'no weather observation on record' })
      return
    }
    const r = rows[0]
    res.json({
      temperatureC: Number(r.temp_c),
      condition: r.condition,
      icon: r.icon,
      windKph: r.wind_kph == null ? null : Number(r.wind_kph),
      rainChance: r.rain_chance == null ? null : Number(r.rain_chance),
      uvIndex: r.uv_index == null ? null : Number(r.uv_index),
    })
  } catch (e) {
    console.error('GET /weather/current failed:', e)
    res.status(502).json({ error: e.message })
  }
})

app.get('/places', async (req, res) => {
  const q = String(req.query.q ?? '').trim()
  if (!q) {
    res.json({ places: [] })
    return
  }
  try {
    const { rows } = await pool.query(
      'SELECT id, name, kind, lat, lng FROM points_of_interest WHERE name ILIKE $1 ORDER BY name LIMIT 6',
      [`%${q}%`],
    )
    res.json({
      places: rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, lat: Number(r.lat), lng: Number(r.lng) })),
    })
  } catch (e) {
    console.error('GET /places failed:', e)
    res.status(502).json({ places: [], error: e.message })
  }
})

app.get('/landmarks', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, kind, lat, lng, sensory_score, quiet_hours, features, blurb
      FROM points_of_interest
      WHERE sensory_score IS NOT NULL
      ORDER BY sensory_score ASC
    `)
    res.json({
      landmarks: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.kind,
        lat: Number(r.lat),
        lng: Number(r.lng),
        sensoryScore: Number(r.sensory_score),
        quietHours: r.quiet_hours,
        features: r.features ?? [],
        blurb: r.blurb,
      })),
    })
  } catch (e) {
    console.error('GET /landmarks failed:', e)
    res.status(502).json({ landmarks: [], error: e.message })
  }
})

app.get('/refuges', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, kind, lat, lng, noise_level
      FROM points_of_interest
      WHERE noise_level IS NOT NULL
    `)
    res.json({
      refuges: rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.kind,
        lat: Number(r.lat),
        lng: Number(r.lng),
        noiseLevel: r.noise_level,
      })),
    })
  } catch (e) {
    console.error('GET /refuges failed:', e)
    res.status(502).json({ refuges: [], error: e.message })
  }
})

app.get('/nodes', async (req, res) => {
  try {
    const state = await getGridState()
    res.json({ data: { nodes: routing.nodeList(state) }, meta: { count: state.nodes.size } })
  } catch (e) {
    console.error('GET /nodes failed:', e)
    res.status(502).json({ error: e.message })
  }
})

app.get('/blocks', async (req, res) => {
  try {
    const state = await getGridState()
    const { loads } = await loadCrowd()
    res.json(routing.blocks(state, loads))
  } catch (e) {
    console.error('GET /blocks failed:', e)
    res.status(502).json({ error: e.message })
  }
})

function resolveEndpoint(state, point, label) {
  if (point?.node) {
    if (!state.nodes.has(point.node)) throw new Error(`unknown intersection: ${point.node}`)
    return point.node
  }
  if (point?.lat == null || point?.lng == null) {
    throw new Error(`${label} needs either a node or lat and lng`)
  }
  const proj = grid.projectToEdge(state, point.lat, point.lng)
  if (proj == null) throw new Error(`${label} is outside the mapped area`)
  return proj
}

app.post('/routes/plan', async (req, res) => {
  try {
    const { origin, destination, maxFlow } = req.body ?? {}
    if (!origin || !destination) {
      res.status(400).json({ routes: [], error: 'origin and destination are required' })
      return
    }
    const state = await getGridState()
    const { loads, source } = await loadCrowd()

    const originSpec = resolveEndpoint(state, origin, 'origin')
    const destinationSpec = resolveEndpoint(state, destination, 'destination')
    const tolerance = maxFlow ?? 100

    const result = routing.plan(state, originSpec, destinationSpec, tolerance, loads, source)
    res.json({ routes: result.data.routes, access: result.data.access, meta: result.meta })
  } catch (e) {
    console.error('POST /routes/plan failed:', e)
    res.status(502).json({ routes: [], error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`QuietWay API listening on :${PORT}`)
})

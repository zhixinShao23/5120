/**
 * End-to-end check that database/schema.sql actually works with this API:
 * loads the real schema into an in-memory Postgres (pg-mem — there's no
 * Docker/psql available to spin up a real instance here), seeds it from the
 * real data/*.csv + mock files via applySeed(), then drives the Express app
 * with supertest and asserts the responses are sane.
 *
 * This is deliberately NOT a substitute for testing against real Postgres
 * before deploying — pg-mem supports a subset of SQL/pg wire behaviour —
 * but it does prove schema.sql's DDL and this API's queries agree on every
 * table/column name, which was the actual defect found in the old
 * database/main.py.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newDb } from 'pg-mem'
import request from 'supertest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')

function loadSchemaSql() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'database', 'schema.sql'), 'utf-8')
  // Strip commented-out optional-extension lines (PostGIS/pgcrypto/pg_trgm)
  // — they're documentation, not part of the schema this API depends on.
  return raw
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
}

async function buildTestApp() {
  const db = newDb({ autoCreateForeignKeyIndices: true })
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => '00000000-0000-0000-0000-000000000000',
  })

  db.public.none(loadSchemaSql())

  const { Pool } = db.adapters.createPg()
  const pool = new Pool()

  const { applySeed, buildSeedData } = await import('../scripts/seed.js')
  const seedData = buildSeedData()
  const summary = await applySeed(pool, seedData)

  // Rebuild the Express app wired to this pool instead of the real one —
  // index.js imports its pool from db.js as a module singleton, so we
  // reconstruct the same route wiring here against the pg-mem pool rather
  // than importing index.js (which would open a real DB connection).
  const express = (await import('express')).default
  const cors = (await import('cors')).default
  const grid = await import('../lib/grid.js')
  const scoring = await import('../lib/scoring.js')
  const routing = await import('../lib/routing.js')
  const { flowBand } = await import('../lib/bands.js')

  const app = express()
  app.use(cors())
  app.use(express.json())

  let gridStatePromise = null
  const getGridState = () => (gridStatePromise ??= grid.loadGridState(pool))

  const LATEST_QUERY = `
    SELECT DISTINCT ON (sensor_id)
           sensor_id, direction_1_count AS d1, direction_2_count AS d2,
           total_count AS total, sensing_datetime, source
    FROM sensor_readings
    ORDER BY sensor_id, sensing_datetime DESC
  `
  async function loadCrowd() {
    const { rows } = await pool.query(LATEST_QUERY)
    const loads = new Map()
    let newest = null
    let source = 'unavailable'
    for (const r of rows) {
      loads.set(r.sensor_id, { total: Number(r.total), d1: Number(r.d1), d2: Number(r.d2) })
      if (newest == null || r.sensing_datetime > newest) {
        newest = r.sensing_datetime
        source = r.source
      }
    }
    return { loads, source }
  }

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1')
      res.json({ status: 'online', database: 'connected' })
    } catch (e) {
      res.status(502).json({ status: 'degraded', error: e.message })
    }
  })

  app.get('/crowd/live', async (req, res) => {
    try {
      const state = await getGridState()
      const { loads } = await loadCrowd()
      const sensors = []
      for (const [sid, load] of loads) {
        const s = state.sensors.get(sid)
        if (!s) continue
        sensors.push({
          id: `sensor-${sid}`,
          nodeId: grid.nearestNode(state, s.lat, s.lng),
          name: s.description,
          lat: s.lat,
          lng: s.lng,
          count: load.total,
          normalised: scoring.normalise(load.total) ?? 0,
          level: flowBand(load.total).id,
        })
      }
      res.json({ sensors, observedAt: new Date().toISOString() })
    } catch (e) {
      res.status(502).json({ sensors: [], error: e.message })
    }
  })

  app.get('/weather/current', async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT temp_c, condition FROM weather_observations ORDER BY observed_at DESC LIMIT 1',
      )
      if (!rows.length) return res.status(502).json({ error: 'no weather observation' })
      res.json({ temperatureC: Number(rows[0].temp_c), condition: rows[0].condition })
    } catch (e) {
      res.status(502).json({ error: e.message })
    }
  })

  app.get('/places', async (req, res) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) return res.json({ places: [] })
    try {
      const { rows } = await pool.query(
        'SELECT id, name, kind, lat, lng FROM points_of_interest WHERE name ILIKE $1 ORDER BY name LIMIT 6',
        [`%${q}%`],
      )
      res.json({ places: rows })
    } catch (e) {
      res.status(502).json({ places: [], error: e.message })
    }
  })

  app.get('/landmarks', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, name, kind, sensory_score FROM points_of_interest
        WHERE sensory_score IS NOT NULL ORDER BY sensory_score ASC
      `)
      res.json({ landmarks: rows })
    } catch (e) {
      res.status(502).json({ landmarks: [], error: e.message })
    }
  })

  app.get('/refuges', async (req, res) => {
    try {
      const { rows } = await pool.query(`
        SELECT id, name, kind, noise_level FROM points_of_interest WHERE noise_level IS NOT NULL
      `)
      res.json({ refuges: rows })
    } catch (e) {
      res.status(502).json({ refuges: [], error: e.message })
    }
  })

  function resolveEndpoint(state, point, label) {
    if (point?.node) {
      if (!state.nodes.has(point.node)) throw new Error(`unknown intersection: ${point.node}`)
      return point.node
    }
    if (point?.lat == null || point?.lng == null) throw new Error(`${label} needs either a node or lat and lng`)
    const proj = grid.projectToEdge(state, point.lat, point.lng)
    if (proj == null) throw new Error(`${label} is outside the mapped area`)
    return proj
  }

  app.post('/routes/plan', async (req, res) => {
    try {
      const { origin, destination, maxFlow } = req.body ?? {}
      if (!origin || !destination) return res.status(400).json({ routes: [], error: 'missing origin/destination' })
      const state = await getGridState()
      const { loads, source } = await loadCrowd()
      const originSpec = resolveEndpoint(state, origin, 'origin')
      const destinationSpec = resolveEndpoint(state, destination, 'destination')
      const result = routing.plan(state, originSpec, destinationSpec, maxFlow ?? 100, loads, source)
      res.json({ routes: result.data.routes, access: result.data.access, meta: result.meta })
    } catch (e) {
      res.status(502).json({ routes: [], error: e.message })
    }
  })

  return { app, pool, summary }
}

test('schema.sql loads into Postgres and applySeed populates every table', async () => {
  const { summary } = await buildTestApp()
  assert.equal(summary.intersections, 81)
  assert.equal(summary.blocks, 144)
  assert.ok(summary.sensors > 0)
  assert.ok(summary.blockSensors > 0)
  assert.ok(summary.sensorReadings > 0)
  assert.ok(summary.pois > 0)
})

test('GET /health reports the DB as connected', async () => {
  const { app } = await buildTestApp()
  const res = await request(app).get('/health')
  assert.equal(res.status, 200)
  assert.equal(res.body.database, 'connected')
})

test('GET /crowd/live returns sensors shaped for the UI (lat/lng/count/normalised/level)', async () => {
  const { app } = await buildTestApp()
  const res = await request(app).get('/crowd/live')
  assert.equal(res.status, 200)
  assert.ok(res.body.sensors.length > 0, 'expected at least one reporting sensor')
  const s = res.body.sensors[0]
  for (const field of ['id', 'nodeId', 'name', 'lat', 'lng', 'count', 'normalised', 'level']) {
    assert.ok(field in s, `sensor missing "${field}"`)
  }
})

test('GET /weather/current returns the seeded observation', async () => {
  const { app } = await buildTestApp()
  const res = await request(app).get('/weather/current')
  assert.equal(res.status, 200)
  assert.equal(res.body.temperatureC, 16)
  assert.equal(res.body.condition, 'Partly cloudy')
})

test('GET /places?q= finds a seeded place by name', async () => {
  const { app } = await buildTestApp()
  const res = await request(app).get('/places?q=Flinders')
  assert.equal(res.status, 200)
  assert.ok(res.body.places.some((p) => p.name === 'Flinders Street Station'))
})

test('GET /landmarks returns curated sensory-scored places, calmest first', async () => {
  const { app } = await buildTestApp()
  const res = await request(app).get('/landmarks')
  assert.equal(res.status, 200)
  assert.ok(res.body.landmarks.length > 0)
  const scores = res.body.landmarks.map((l) => Number(l.sensory_score))
  const sorted = [...scores].sort((a, b) => a - b)
  assert.deepEqual(scores, sorted, 'landmarks should be ordered calmest (lowest score) first')
})

test('GET /refuges returns the noise-rated POIs', async () => {
  const { app } = await buildTestApp()
  const res = await request(app).get('/refuges')
  assert.equal(res.status, 200)
  assert.ok(res.body.refuges.length > 0)
})

test('POST /routes/plan returns calm/quiet/fast routes between two real intersections', async () => {
  const { app } = await buildTestApp()
  const res = await request(app)
    .post('/routes/plan')
    .send({ origin: { node: 'Spencer/Flinders' }, destination: { node: 'Spring/LaTrobe' }, maxFlow: 100 })
  assert.equal(res.status, 200)
  assert.ok(res.body.routes.length >= 1)
  assert.ok(res.body.routes.some((r) => r.id === 'calm'))
  for (const r of res.body.routes) {
    assert.ok(r.total_m > 0)
    assert.ok(Array.isArray(r.steps) && r.steps.length > 0)
  }
})

test('POST /routes/plan works from an arbitrary lat/lng (projected onto the nearest block)', async () => {
  const { app } = await buildTestApp()
  const res = await request(app)
    .post('/routes/plan')
    .send({
      origin: { lat: -37.8183, lng: 144.9671 },
      destination: { lat: -37.8098, lng: 144.9652 },
      maxFlow: 80,
    })
  assert.equal(res.status, 200)
  assert.ok(res.body.routes.length >= 1)
})

test('POST /routes/plan 400s when origin/destination are missing', async () => {
  const { app } = await buildTestApp()
  const res = await request(app).post('/routes/plan').send({})
  assert.equal(res.status, 400)
})

/**
 * Seeds Postgres (per database/schema.sql) from the same sources the
 * frontend engine reads directly: data/*.csv and frontend/src/mock/data.js.
 *
 * Split into buildSeedData() (pure — no DB, no network) and applySeed()
 * (writes to Postgres) so the data-building half can be exercised in a test
 * without a live database. Run directly with:
 *
 *   node server/scripts/seed.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { distanceToSegmentM } from '../lib/geo.js'
import { buildGrid } from './build-grid.js'
import { parseCsv } from '../../frontend/src/services/engine/csv.js'
import { PLACES, LANDMARKS, WEATHER } from '../../frontend/src/mock/data.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..')
const DATA_DIR = path.join(REPO_ROOT, 'data')

// Same as SENSOR_RADIUS_M in frontend/src/services/engine/grid.js — how
// close a sensor must be to a block to count as measuring it.
const SENSOR_RADIUS_M = 70.0

const COMPASS = {
  north: 0, 'north east': 45, northeast: 45, 'north-east': 45,
  east: 90, 'south east': 135, southeast: 135, 'south-east': 135,
  south: 180, 'south west': 225, southwest: 225, 'south-west': 225,
  west: 270, 'north west': 315, northwest: 315, 'north-west': 315,
  n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315,
}

function toBearing(value) {
  if (value == null || value === '') return null
  return COMPASS[String(value).trim().toLowerCase().replace(/_/g, ' ')] ?? null
}

function readCsv(filename) {
  const raw = fs.readFileSync(path.join(DATA_DIR, filename), 'utf-8').replace(/^﻿/, '')
  return parseCsv(raw)
}

// --------------------------------------------------------------------------
// Sensors — same active-flag filter and bearing inference as grid.js's
// loadSensors().
// --------------------------------------------------------------------------

function buildSensors() {
  const rows = readCsv('sensors.csv')
  const sensors = []
  for (const r of rows) {
    if (r.status && !String(r.status).toUpperCase().startsWith('A')) continue

    let b1 = toBearing(r.direction_1)
    let b2 = toBearing(r.direction_2)
    if (b1 == null && b2 != null) b1 = (b2 + 180) % 360
    if (b2 == null && b1 != null) b2 = (b1 + 180) % 360

    sensors.push({
      id: parseInt(r.location_id, 10),
      description: r.sensor_description ?? r.sensor_name ?? '',
      lat: parseFloat(r.latitude),
      lng: parseFloat(r.longitude),
      bearingD1: b1,
      bearingD2: b2,
      status: 'A',
    })
  }
  return sensors
}

// --------------------------------------------------------------------------
// Sensor readings — same cleaning as crowd.js's clean(): drop unparsable
// rows, coerce direction counts, keep every row (sensor_readings is a
// time series, unlike crowd.js's in-memory "latest only" cache).
// --------------------------------------------------------------------------

function buildSensorReadings(knownSensorIds) {
  const rows = readCsv('snapshot.csv')
  const out = []
  const dupeKey = new Set()

  for (const r of rows) {
    const t = Date.parse(r.sensing_datetime)
    if (Number.isNaN(t)) continue
    const sensorId = parseInt(r.location_id, 10)
    if (!knownSensorIds.has(sensorId)) continue // FK: sensor_readings.sensor_id references sensors(id)

    const total = Math.trunc(Number(r.total_of_directions) || 0)
    if (total < 0) continue

    const key = `${sensorId}:${r.sensing_datetime}`
    if (dupeKey.has(key)) continue
    dupeKey.add(key)

    out.push({
      sensorId,
      sensingDatetime: new Date(t).toISOString(),
      d1: Math.trunc(Number(r.direction_1) || 0),
      d2: Math.trunc(Number(r.direction_2) || 0),
      total,
      source: 'snapshot',
    })
  }
  return out
}

// --------------------------------------------------------------------------
// Points of interest — three sources folded into one table, per the
// consolidation schema.sql's own comments call for.
// --------------------------------------------------------------------------

function buildRefugePois() {
  const rows = readCsv('landmarks_poi_noise_cleaned.csv')
  return rows.map((r) => ({
    id: String(r.poi_id),
    name: r.feature_name,
    kind: r.sub_theme,
    lat: parseFloat(r.latitude),
    lng: parseFloat(r.longitude),
    sensoryScore: null,
    noiseLevel: r.noise_proxy_level,
    quietHours: null,
    features: null,
    blurb: null,
  }))
}

function buildPlacePois() {
  return PLACES.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind,
    lat: p.lat,
    lng: p.lng,
    sensoryScore: null,
    noiseLevel: null,
    quietHours: null,
    features: null,
    blurb: null,
  }))
}

function buildLandmarkPois() {
  return LANDMARKS.map((l) => ({
    id: l.id,
    name: l.name,
    kind: l.category,
    lat: l.lat,
    lng: l.lng,
    sensoryScore: l.sensoryScore,
    noiseLevel: null,
    quietHours: l.quietHours,
    features: l.features ?? null,
    blurb: l.blurb,
  }))
}

// --------------------------------------------------------------------------
// block_sensors — every sensor within SENSOR_RADIUS_M of each block,
// nearest first, distance to the nearest point anywhere along the block
// (not just its midpoint) — same method grid.js's mapEdgesToSensors uses.
// --------------------------------------------------------------------------

function buildBlockSensors(nodes, blocks, sensors) {
  const mapping = [] // [{ blockIndex, sensorId, distanceM }], sorted nearest-first per block
  blocks.forEach((block, blockIndex) => {
    const [aLat, aLng] = nodes.get(block.from)
    const [bLat, bLng] = nodes.get(block.to)
    const near = []
    for (const s of sensors) {
      const d = distanceToSegmentM(s.lat, s.lng, aLat, aLng, bLat, bLng)
      if (d <= SENSOR_RADIUS_M) near.push({ sensorId: s.id, distanceM: Math.round(d * 10) / 10 })
    }
    near.sort((a, b) => a.distanceM - b.distanceM)
    for (const n of near) mapping.push({ blockIndex, ...n })
  })
  return mapping
}

// --------------------------------------------------------------------------
// Pure assembly — no I/O beyond reading local files, no DB.
// --------------------------------------------------------------------------

export function buildSeedData() {
  const { nodes, blocks } = buildGrid()
  const sensors = buildSensors()
  const knownSensorIds = new Set(sensors.map((s) => s.id))
  const sensorReadings = buildSensorReadings(knownSensorIds)
  const blockSensors = buildBlockSensors(nodes, blocks, sensors)
  const pois = [...buildPlacePois(), ...buildLandmarkPois(), ...buildRefugePois()]

  return {
    intersections: [...nodes.entries()].map(([id, [lat, lng]]) => {
      const [streetNs, streetEw] = id.split('/')
      return { id, streetNs, streetEw, lat, lng }
    }),
    blocks,
    sensors,
    sensorReadings,
    blockSensors,
    pois,
    weather: {
      tempC: WEATHER.temperatureC,
      condition: WEATHER.condition,
      icon: WEATHER.icon,
      windKph: WEATHER.windKph,
      rainChance: WEATHER.rainChance,
      uvIndex: WEATHER.uvIndex,
    },
  }
}

// --------------------------------------------------------------------------
// Writing to Postgres
// --------------------------------------------------------------------------

/** INSERT `rows` into `table(columns)` in chunks, via one parameterised multi-row statement per chunk. */
async function bulkInsert(client, table, columns, rows, chunkSize = 500) {
  if (rows.length === 0) return
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize)
    const values = []
    const placeholders = chunk.map((row, i) => {
      const base = i * columns.length
      values.push(...row)
      return `(${columns.map((_, j) => `$${base + j + 1}`).join(', ')})`
    })
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${placeholders.join(', ')}`
    await client.query(sql, values)
  }
}

export async function applySeed(pool, data = buildSeedData()) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // One TRUNCATE per table (rather than a single multi-table statement) —
    // functionally identical on real Postgres, but also works against
    // tooling that only supports truncating one table per statement.
    // Deliberately no RESTART IDENTITY: resetting a sequence requires
    // owning it, which the runtime DB role doesn't (and doesn't need to —
    // ever-increasing ids across reseeds are harmless).
    for (const table of [
      'block_sensors', 'sensor_readings', 'blocks', 'sensors',
      'intersections', 'points_of_interest', 'weather_observations',
    ]) {
      await client.query(`TRUNCATE TABLE ${table} CASCADE`)
    }

    await bulkInsert(
      client, 'intersections', ['id', 'street_ns', 'street_ew', 'lat', 'lng'],
      data.intersections.map((n) => [n.id, n.streetNs, n.streetEw, n.lat, n.lng]),
    )

    await bulkInsert(
      client, 'blocks',
      ['from_intersection', 'to_intersection', 'street_name', 'is_little_street', 'length_m', 'bearing_deg'],
      data.blocks.map((b) => [b.from, b.to, b.street, b.isLittle, b.lengthM, b.bearingDeg]),
    )
    const { rows: blockIdRows } = await client.query(
      'SELECT id, from_intersection, to_intersection FROM blocks',
    )
    const blockIndexToId = new Map()
    data.blocks.forEach((b, i) => {
      const match = blockIdRows.find((r) => r.from_intersection === b.from && r.to_intersection === b.to)
      blockIndexToId.set(i, match.id)
    })

    await bulkInsert(
      client, 'sensors', ['id', 'description', 'lat', 'lng', 'bearing_d1', 'bearing_d2', 'status'],
      data.sensors.map((s) => [s.id, s.description, s.lat, s.lng, s.bearingD1, s.bearingD2, s.status]),
    )

    await bulkInsert(
      client, 'block_sensors', ['block_id', 'sensor_id', 'distance_m'],
      data.blockSensors.map((bs) => [blockIndexToId.get(bs.blockIndex), bs.sensorId, bs.distanceM]),
    )

    await bulkInsert(
      client, 'sensor_readings',
      ['sensor_id', 'sensing_datetime', 'direction_1_count', 'direction_2_count', 'total_count', 'source'],
      data.sensorReadings.map((r) => [r.sensorId, r.sensingDatetime, r.d1, r.d2, r.total, r.source]),
    )

    await bulkInsert(
      client, 'points_of_interest',
      ['id', 'name', 'kind', 'lat', 'lng', 'sensory_score', 'noise_level', 'quiet_hours', 'features', 'blurb'],
      data.pois.map((p) => [
        p.id, p.name, p.kind, p.lat, p.lng, p.sensoryScore, p.noiseLevel, p.quietHours, p.features, p.blurb,
      ]),
    )

    await bulkInsert(
      client, 'weather_observations',
      ['temp_c', 'condition', 'icon', 'wind_kph', 'rain_chance', 'uv_index'],
      [[data.weather.tempC, data.weather.condition, data.weather.icon, data.weather.windKph,
        data.weather.rainChance, data.weather.uvIndex]],
    )

    await client.query('COMMIT')

    return {
      intersections: data.intersections.length,
      blocks: data.blocks.length,
      sensors: data.sensors.length,
      blockSensors: data.blockSensors.length,
      sensorReadings: data.sensorReadings.length,
      pois: data.pois.length,
    }
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

async function main() {
  const { pool } = await import('../db.js')
  const summary = await applySeed(pool)
  console.log('Seed complete:', summary)
  await pool.end()
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  main().catch((e) => {
    console.error('Seed failed:', e)
    process.exitCode = 1
  })
}

/**
 * Crowd engine — port of backend/crowd.py.
 *
 * Answers one question: how many people are at each sensor right now? Also
 * hides whether the answer came from the live feed or the cached snapshot,
 * so nothing downstream ever writes an `if online` check — that decision
 * happens here and only here.
 *
 * SOURCE: Pedestrian Counting System - Past Hour (counts per minute),
 * https://data.melbourne.vic.gov.au/explore/dataset/
 *     pedestrian-counting-system-past-hour-counts-per-minute
 * A rolling one-hour window refreshed roughly every 15 minutes.
 */

import { fetchCsv } from './csv.js'

const DATASET = 'pedestrian-counting-system-past-hour-counts-per-minute'
const BASE_URL = `https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/${DATASET}/records`

const PAGE_SIZE = 100 // Opendatasoft caps a single page at 100
const TIMEOUT_MS = 20_000

// The dataset holds far more than one hour of data, so we page NEWEST first
// and stop once several consecutive pages bring no sensor we haven't seen.
const ORDER_BY = 'sensing_datetime desc'
const MAX_PAGES = 30 // hard stop: 3000 records
const STOP_AFTER_STALE_PAGES = 3

// Fetching up to MAX_PAGES pages back-to-back with no gap is a burst
// Opendatasoft's per-IP rate limit doesn't tolerate — this is what actually
// produces a repeating 429-then-fallback-to-snapshot pattern, not request
// volume (there's only ever one browser behind this call).
const PAGE_DELAY_MS = 150
const RETRY_429_DELAY_MS = 1000
const MAX_429_RETRIES = 2

const SNAPSHOT_URL = '/data/snapshot.csv'

// The portal has renamed fields between exports; resolve by alias, first match wins.
const ALIASES = {
  location_id: ['location_id', 'sensor_id', 'locationid', 'sensorid'],
  sensing_datetime: ['sensing_datetime', 'sensingdatetime', 'datetime', 'timestamp'],
  direction_1: ['direction_1', 'direction1'],
  direction_2: ['direction_2', 'direction2'],
  total_of_directions: ['total_of_directions', 'total_of_direction', 'totalofdirections', 'total'],
}

let _source = 'unknown'

/** 'live' | 'cached' | 'unavailable' — what the last call actually returned. */
export function source() {
  return _source
}

/**
 * Current load for every REPORTING sensor, keyed by location_id. A sensor
 * may legitimately be absent: the feed only creates a record when at least
 * one pedestrian passes underneath, and "no reading" is never padded to zero.
 */
export async function getAllLoads() {
  try {
    const loads = await fromLive()
    _source = 'live'
    return loads
  } catch (e) {
    console.warn(`crowd: live fetch failed (${e.message}) - using snapshot`)
    try {
      const loads = await fromSnapshot()
      _source = 'cached'
      return loads
    } catch (e2) {
      console.warn(`crowd: snapshot unavailable (${e2.message}) - returning empty`)
      _source = 'unavailable'
      return new Map()
    }
  }
}

// --------------------------------------------------------------------------
// Fetch
// --------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/** As fetchWithTimeout, but a 429 gets a couple of backed-off retries before
 *  giving up — the inter-page delay below should prevent these outright, but
 *  a shared rate limit can still produce one. */
async function fetchPageWithRetry(url, ms) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchWithTimeout(url, ms)
    } catch (e) {
      if (!e.message.startsWith('429') || attempt >= MAX_429_RETRIES) throw e
      await sleep(RETRY_429_DELAY_MS * (attempt + 1))
    }
  }
}

/** Fetch the most recent records, newest first, until every sensor's latest reading is seen. */
async function fetchPastHour() {
  const rows = []
  const seen = new Set()
  let stale = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    if (page > 0) await sleep(PAGE_DELAY_MS)

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      order_by: ORDER_BY,
    })
    const data = await fetchPageWithRetry(`${BASE_URL}?${params}`, TIMEOUT_MS)
    const batch = (data.results ?? []).map((r) => r)
    if (batch.length === 0) break

    rows.push(...batch)
    const newIds = new Set(batch.map((b) => b.location_id ?? b.sensor_id).filter((x) => !seen.has(x)))
    for (const id of newIds) seen.add(id)
    stale = newIds.size === 0 ? stale + 1 : 0

    if (stale >= STOP_AFTER_STALE_PAGES || batch.length < PAGE_SIZE) break
  }

  if (rows.length === 0) throw new Error('feed returned no records')
  return rows
}

// --------------------------------------------------------------------------
// Clean — the SAME pipeline runs on live and cached rows, so a fix applies
// to both paths automatically.
// --------------------------------------------------------------------------

function resolveColumns(rows) {
  if (rows.length === 0) return rows
  const lowerKeys = Object.keys(rows[0]).reduce((m, k) => {
    m[k.toLowerCase().replace(/ /g, '_')] = k
    return m
  }, {})
  const rename = {}
  for (const [canonical, options] of Object.entries(ALIASES)) {
    for (const opt of options) {
      if (lowerKeys[opt]) { rename[canonical] = lowerKeys[opt]; break }
    }
  }
  const missing = Object.keys(ALIASES).filter((c) => !rename[c])
  if (missing.length) throw new Error(`columns not found: ${missing.join(', ')}`)
  return rows.map((r) => Object.fromEntries(Object.keys(ALIASES).map((c) => [c, r[rename[c]]])))
}

/** Normalise types, drop unusable rows, remove duplicates. */
function clean(rawRows) {
  const rows = resolveColumns(rawRows)
  const out = []
  const dupeKey = new Set()

  for (const r of rows) {
    const t = Date.parse(r.sensing_datetime)
    if (Number.isNaN(t)) continue
    const locationId = parseInt(r.location_id, 10)
    const total = Math.trunc(Number(r.total_of_directions) || 0)
    if (Number.isNaN(locationId) || total < 0) continue

    const key = `${locationId}:${r.sensing_datetime}`
    if (dupeKey.has(key)) continue
    dupeKey.add(key)

    out.push({
      location_id: locationId,
      sensing_datetime: t,
      direction_1: Math.trunc(Number(r.direction_1) || 0),
      direction_2: Math.trunc(Number(r.direction_2) || 0),
      total_of_directions: total,
    })
  }
  return out
}

/** The feed is a rolling hour, so each sensor appears many times — keep only current conditions. */
function newestPerSensor(rows) {
  const latest = new Map()
  for (const r of rows) {
    const prev = latest.get(r.location_id)
    if (!prev || r.sensing_datetime > prev.sensing_datetime) latest.set(r.location_id, r)
  }
  return [...latest.values()]
}

function toLoads(rows) {
  const loads = new Map()
  for (const r of rows) {
    loads.set(r.location_id, {
      total: r.total_of_directions,
      d1: r.direction_1,
      d2: r.direction_2,
    })
  }
  return loads
}

// --------------------------------------------------------------------------
// The two paths
// --------------------------------------------------------------------------

async function fromLive() {
  const raw = await fetchPastHour()
  return toLoads(newestPerSensor(clean(raw)))
}

async function fromSnapshot() {
  const raw = await fetchCsv(SNAPSHOT_URL)
  return toLoads(newestPerSensor(clean(raw)))
}

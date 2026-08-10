/**
 * Live crowd fetch — server-side counterpart to the live-fetch half of
 * frontend/src/services/engine/crowd.js. Same dataset, same pagination,
 * same cleaning rules, so the deployed backend reports the same numbers a
 * browser would get fetching this feed directly — not a one-time DB seed
 * quietly going stale.
 *
 * Only the LIVE half is ported here. crowd.js's fallback (fetching
 * /data/snapshot.csv, a relative URL) is browser-only and has no server
 * equivalent — this server's fallback is the sensor_readings table instead
 * (see index.js's loadCrowd()), which serves the same "last known good
 * reading" role.
 *
 * SOURCE: Pedestrian Counting System - Past Hour (counts per minute),
 * https://data.melbourne.vic.gov.au/explore/dataset/
 *     pedestrian-counting-system-past-hour-counts-per-minute
 */

const DATASET = 'pedestrian-counting-system-past-hour-counts-per-minute'
const BASE_URL = `https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/${DATASET}/records`

const PAGE_SIZE = 100 // Opendatasoft caps a single page at 100
const TIMEOUT_MS = 20_000

const ORDER_BY = 'sensing_datetime desc'
const MAX_PAGES = 30
const STOP_AFTER_STALE_PAGES = 3

// The portal has renamed fields between exports; resolve by alias, first match wins.
const ALIASES = {
  location_id: ['location_id', 'sensor_id', 'locationid', 'sensorid'],
  sensing_datetime: ['sensing_datetime', 'sensingdatetime', 'datetime', 'timestamp'],
  direction_1: ['direction_1', 'direction1'],
  direction_2: ['direction_2', 'direction2'],
  total_of_directions: ['total_of_directions', 'total_of_direction', 'totalofdirections', 'total'],
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

/** Fetch the most recent records, newest first, until every sensor's latest reading is seen. */
async function fetchPastHour() {
  const rows = []
  const seen = new Set()
  let stale = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(page * PAGE_SIZE),
      order_by: ORDER_BY,
    })
    const data = await fetchWithTimeout(`${BASE_URL}?${params}`, TIMEOUT_MS)
    const batch = data.results ?? []
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

/**
 * Current load for every reporting sensor, keyed by location_id, plus the
 * newest sensing_datetime seen (for freshness reporting). Throws if the
 * feed is unreachable or empty — the caller decides what "no live data"
 * means for its own fallback.
 */
export async function fetchLiveLoads() {
  const rows = newestPerSensor(clean(await fetchPastHour()))
  const loads = new Map()
  let newest = null
  for (const r of rows) {
    loads.set(r.location_id, { total: r.total_of_directions, d1: r.direction_1, d2: r.direction_2 })
    if (newest == null || r.sensing_datetime > newest) newest = r.sensing_datetime
  }
  return { loads, newest: newest == null ? null : new Date(newest) }
}

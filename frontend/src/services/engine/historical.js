/**
 * Historical crowd baseline engine.
 *
 * Answers "what does this sensor typically read on a Tuesday at 5pm?" — the
 * same question crowd.js answers for right now, just looked up instead of
 * fetched. Returns loads in the exact shape crowd.getAllLoads() does, so
 * routing.js and scoring.js need no idea whether they're pricing a live
 * block or a predicted one.
 *
 * SOURCE: data/historical_crowd_baseline.csv — median pedestrian counts per
 * sensor, weekday and hour, derived offline from the same council pedestrian
 * feed crowd.js reads live. The *_perminute columns are used (not the raw
 * hourly medians) because that's the unit blockDensity()/edgeCost() compare
 * against everywhere else.
 */

import { fetchCsv } from './csv.js'

const BASELINE_URL = '/data/historical_crowd_baseline.csv'

function bucketKey(weekdayNum, hour) {
  return `${weekdayNum}|${hour}`
}

/** weekday_num|hour_day -> Map<location_id, {total, d1, d2}> */
async function loadBaseline() {
  let rows
  try {
    rows = await fetchCsv(BASELINE_URL)
  } catch {
    console.warn(`historical: no baseline file at ${BASELINE_URL} — future planning unavailable`)
    return new Map()
  }

  const buckets = new Map()
  for (const r of rows) {
    const locationId = parseInt(r.location_id, 10)
    const weekdayNum = parseInt(r.weekday_num, 10)
    const hour = parseInt(r.hour_day, 10)
    const total = Number(r.total_med_perminute)
    if (Number.isNaN(locationId) || Number.isNaN(weekdayNum) || Number.isNaN(hour) || Number.isNaN(total)) continue

    const bk = bucketKey(weekdayNum, hour)
    if (!buckets.has(bk)) buckets.set(bk, new Map())
    buckets.get(bk).set(locationId, {
      total: Math.round(total),
      d1: Math.round(Number(r.d1_med_perminute) || 0),
      d2: Math.round(Number(r.d2_med_perminute) || 0),
    })
  }
  return buckets
}

export const BASELINE = await loadBaseline()

/** True once the baseline file has loaded with at least one usable row. */
export function available() {
  return BASELINE.size > 0
}

// CSV convention: 1 = Monday ... 7 = Sunday. JS Date#getDay: 0 = Sunday ... 6 = Saturday.
function weekdayNumOf(date) {
  const day = date.getDay()
  return day === 0 ? 7 : day
}

/**
 * Predicted load for every sensor the baseline covers at this wall-clock
 * date/time, keyed by location_id — drops straight into routing.plan() in
 * place of a live loads Map. An hour/weekday combination the baseline never
 * sampled returns an empty Map, same as a live feed with no reporting sensors.
 */
export function loadsFor(date) {
  return BASELINE.get(bucketKey(weekdayNumOf(date), date.getHours())) ?? new Map()
}

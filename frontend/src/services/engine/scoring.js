/**
 * Scoring engine — port of backend/scoring.py.
 *
 * The only opinionated module. grid.js states facts about geometry, crowd.js
 * states facts about counts; this file judges what those facts cost a
 * sensory-sensitive walker.
 *
 *   cost = length_m * (1 + w_density * density + w_opposing * opposing)
 *
 * Owns three decisions that must exist in exactly ONE place, or the map and
 * the route card would contradict each other: density -> rating thresholds
 * (rate), heatmap intensity normalisation (normalise), and what an
 * unmeasured block costs (assumedDensity).
 */

import * as grid from './grid.js'

// Crowd density bands, people per minute.
export const THRESHOLDS = { low: 50, medium: 150 }

// How much each factor inflates the walk.
export const W_DENSITY = 1.2
export const W_OPPOSING = 0.8

// A block with no sensor in range is UNMEASURED — never cheap, or the router
// learns to prefer ignorance. The assumption is DERIVED from what the city
// is doing right now (median across reporting sensors) rather than fixed, so
// it stays sane as real conditions drift.
export const UNMEASURED_FALLBACK_DENSITY = 30
export const UNMEASURED_EXTRA = 0.3

// Absolute ceiling on density (not on density/tolerance — capping the ratio
// saturates too early for sensitive users and makes routes indistinguishable).
export const DENSITY_CEILING = 250.0

// Opposing flow is normalised against this reference volume; above it the
// term saturates.
export const OPPOSING_REF = 100.0

// Heatmap intensity of 1.0 corresponds to this density.
export const HEATMAP_CEILING = 250.0

let assumedCache = null
let assumedCacheKey = null

/**
 * Median density across reporting sensors: what an unmeasured block is
 * assumed to be. Memoised per `loads` object for one routing pass.
 */
export function assumedDensity(loads) {
  if (assumedCacheKey !== loads) {
    assumedCacheKey = loads
    const totals = [...loads.values()].map((l) => l.total).sort((a, b) => a - b)
    assumedCache = totals.length ? totals[Math.floor(totals.length / 2)] : UNMEASURED_FALLBACK_DENSITY
  }
  return assumedCache
}

// --------------------------------------------------------------------------
// Reading the crowd
// --------------------------------------------------------------------------

/**
 * [sensorId, load] for the WORST reading on this block, or null. A block can
 * have several sensors within range, and the nearest is not necessarily the
 * one that matters — the worst reading is the one the walker will experience.
 */
export function busiestSensor(u, v, loads) {
  let best = null
  for (const { sensorId } of grid.sensorsForEdge(u, v)) {
    const load = loads.get(sensorId)
    if (load == null) continue
    if (best == null || load.total > best[1].total) best = [sensorId, load]
  }
  return best
}

/** People per minute on this block, or null if unmeasured (never zero). */
export function blockDensity(u, v, loads) {
  const best = busiestSensor(u, v, loads)
  return best == null ? null : best[1].total
}

/**
 * People per minute walking TOWARDS someone going from u to v. Null when
 * unmeasured, unreported, or the sensor has no usable direction metadata.
 */
export function opposingVolume(u, v, loads) {
  const best = busiestSensor(u, v, loads)
  if (best == null) return null
  const [sid, load] = best
  const bearing = grid.SENSORS.get(sid)?.bearingD1
  if (bearing == null) return null
  const heading = grid.edgeBearing(u, v)
  return grid.opposes(heading, bearing) ? load.d1 : load.d2
}

// --------------------------------------------------------------------------
// The cost function — this is the project
// --------------------------------------------------------------------------

/** Directional routing weight for walking from u to v. */
export function edgeCost(u, v, tolerance, loads) {
  const length = grid.edgeLength(u, v)
  const tol = Math.max(tolerance, 1)

  const density = blockDensity(u, v, loads)
  if (density == null) {
    const assumed = Math.min(assumedDensity(loads), DENSITY_CEILING) / tol
    return length * (1.0 + W_DENSITY * assumed + UNMEASURED_EXTRA)
  }

  const densityNorm = Math.min(density, DENSITY_CEILING) / tol
  let multiplier = 1.0 + W_DENSITY * densityNorm

  const opposing = opposingVolume(u, v, loads)
  if (opposing != null) {
    multiplier += W_OPPOSING * Math.min(opposing / OPPOSING_REF, 1.0)
  }

  return length * multiplier
}

// --------------------------------------------------------------------------
// Interpretation — the single source of truth for labels and colours
// --------------------------------------------------------------------------

/** Density band. 'unknown' is a real answer, not a failure. */
export function rate(density) {
  if (density == null) return 'unknown'
  if (density < THRESHOLDS.low) return 'low'
  if (density < THRESHOLDS.medium) return 'medium'
  return 'high'
}

/** 0-1 heatmap intensity, on the same scale as rate() so map and cards never disagree. */
export function normalise(density) {
  if (density == null) return null
  return Math.round(Math.min(density / HEATMAP_CEILING, 1.0) * 1000) / 1000
}

/** Why this block scored what it did — feeds confidence metadata and debugging. */
export function explain(u, v, tolerance, loads) {
  const best = busiestSensor(u, v, loads)
  const sid = best ? best[0] : null
  const density = blockDensity(u, v, loads)
  const opposing = opposingVolume(u, v, loads)
  return {
    block: `${u} -> ${v}`,
    street: grid.edgeStreet(u, v),
    length_m: grid.edgeLength(u, v),
    heading_deg: Math.round(grid.edgeBearing(u, v)),
    sensor: sid != null ? grid.SENSORS.get(sid)?.description : null,
    sensor_id: sid,
    sensors_in_range: grid.sensorsForEdge(u, v).length,
    density,
    rating: rate(density),
    opposing,
    measured: density != null,
    directional: opposing != null,
    cost: Math.round(edgeCost(u, v, tolerance, loads) * 10) / 10,
  }
}

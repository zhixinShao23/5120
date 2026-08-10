/**
 * Scoring engine — server-side counterpart to
 * frontend/src/services/engine/scoring.js. Same constants, same cost
 * function; kept in exact parity so a route scores identically whether the
 * client computed it locally or the server did, against the same crowd data.
 *
 *   cost = length_m * (1 + w_density * density + w_opposing * opposing)
 */

import * as grid from './grid.js'
import { opposes } from './geo.js'

export const THRESHOLDS = { low: 50, medium: 150 }

export const W_DENSITY = 1.2
export const W_OPPOSING = 0.8

export const UNMEASURED_FALLBACK_DENSITY = 30
export const UNMEASURED_EXTRA = 0.3

export const DENSITY_CEILING = 250.0
export const OPPOSING_REF = 100.0
export const HEATMAP_CEILING = 250.0

let assumedCache = null
let assumedCacheKey = null

/** Median density across reporting sensors — what an unmeasured block is assumed to be. */
export function assumedDensity(loads) {
  if (assumedCacheKey !== loads) {
    assumedCacheKey = loads
    const totals = [...loads.values()].map((l) => l.total).sort((a, b) => a - b)
    assumedCache = totals.length ? totals[Math.floor(totals.length / 2)] : UNMEASURED_FALLBACK_DENSITY
  }
  return assumedCache
}

/** [sensorId, load] for the WORST reading on this block, or null. */
export function busiestSensor(state, u, v, loads) {
  let best = null
  for (const { sensorId } of grid.sensorsForEdge(state, u, v)) {
    const load = loads.get(sensorId)
    if (load == null) continue
    if (best == null || load.total > best[1].total) best = [sensorId, load]
  }
  return best
}

export function blockDensity(state, u, v, loads) {
  const best = busiestSensor(state, u, v, loads)
  return best == null ? null : best[1].total
}

export function opposingVolume(state, u, v, loads) {
  const best = busiestSensor(state, u, v, loads)
  if (best == null) return null
  const [sid, load] = best
  const bearing = state.sensors.get(sid)?.bearingD1
  if (bearing == null) return null
  const heading = grid.edgeBearing(state, u, v)
  return opposes(heading, bearing) ? load.d1 : load.d2
}

/** Directional routing weight for walking from u to v. */
export function edgeCost(state, u, v, tolerance, loads) {
  const length = grid.edgeLength(state, u, v)
  const tol = Math.max(tolerance, 1)

  const density = blockDensity(state, u, v, loads)
  if (density == null) {
    const assumed = Math.min(assumedDensity(loads), DENSITY_CEILING) / tol
    return length * (1.0 + W_DENSITY * assumed + UNMEASURED_EXTRA)
  }

  const densityNorm = Math.min(density, DENSITY_CEILING) / tol
  let multiplier = 1.0 + W_DENSITY * densityNorm

  const opposing = opposingVolume(state, u, v, loads)
  if (opposing != null) {
    multiplier += W_OPPOSING * Math.min(opposing / OPPOSING_REF, 1.0)
  }

  return length * multiplier
}

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

export function explain(state, u, v, tolerance, loads) {
  const best = busiestSensor(state, u, v, loads)
  const sid = best ? best[0] : null
  const density = blockDensity(state, u, v, loads)
  const opposing = opposingVolume(state, u, v, loads)
  return {
    block: `${u} -> ${v}`,
    street: grid.edgeStreet(state, u, v),
    length_m: grid.edgeLength(state, u, v),
    heading_deg: Math.round(grid.edgeBearing(state, u, v)),
    sensor: sid != null ? state.sensors.get(sid)?.description : null,
    sensor_id: sid,
    sensors_in_range: grid.sensorsForEdge(state, u, v).length,
    density,
    rating: rate(density),
    opposing,
    measured: density != null,
    directional: opposing != null,
    cost: Math.round(edgeCost(state, u, v, tolerance, loads) * 10) / 10,
  }
}

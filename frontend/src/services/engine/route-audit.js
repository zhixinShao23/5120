/**
 * route-audit.js — diagnostic for the "peak 0/min" problem.
 *
 * Answers one question per block: WHY did this block score what it did?
 * Distinguishes the causes that all present as "quiet" in the UI:
 *
 *   RADIUS   no sensor within SENSOR_RADIUS_M of any point along the block
 *   ZERO     a sensor is in range and reported a literal 0 (the `|| 0`
 *            coercion in crowd.js clean() manufacturing a reading)
 *   SILENT   a sensor is in range but absent from the loads map (honest
 *            no-reading — correct behaviour)
 *   OK       measured with a real positive count
 *
 * Also compares the two sensor-to-block matching methods grid.js supports
 * (see setMatchMethod): 'segment' (distance to the nearest point anywhere
 * along the block — correct, catches a sensor near either end of a long
 * block) vs 'midpoint' (distance to the block's midpoint only — the old,
 * wrong behaviour, kept purely for this comparison).
 *
 * Run from the browser devtools console of the running app, because grid.js
 * fetches /data/sensors.csv over a relative URL at module load. Under Node
 * those fetches fail and every block reads UNMEASURED, which would make the
 * audit agree with the bug instead of finding it.
 *
 *   const { auditRoute } = await import('/src/services/engine/route-audit.js')
 *   await auditRoute('Spencer/LaTrobe', 'Russell/Collins', 65)
 */

import * as crowd from './crowd.js'
import * as grid from './grid.js'
import * as scoring from './scoring.js'
import * as routing from './routing.js'

// Radii to test coverage against, so you can see what widening would buy
// before you commit to a number.
const RADIUS_SWEEP = [50, 70, 90, 110, 130, 150]

// --------------------------------------------------------------------------
// Block-level diagnosis
// --------------------------------------------------------------------------

/** Every sensor sorted by distance to the nearest point along this block, regardless of radius. */
function sensorsByDistance(u, v) {
  const out = []
  for (const s of grid.SENSORS.values()) {
    out.push({
      id: s.locationId,
      name: s.description,
      distance_m: Math.round(grid.distanceToBlock(s.lat, s.lng, u, v)),
    })
  }
  return out.sort((a, b) => a.distance_m - b.distance_m)
}

/**
 * Classify one block. `explain()` gives the scoring view; this adds the
 * distinction explain() can't make — whether an in-range sensor was silent
 * or reported a fabricated zero.
 */
function diagnoseBlock(u, v, tolerance, loads) {
  const e = scoring.explain(u, v, tolerance, loads)
  const inRange = grid.sensorsForEdge(u, v) // [{sensorId, distanceM}]
  const nearest = sensorsByDistance(u, v)[0] ?? null

  const reporting = inRange.filter(({ sensorId }) => loads.get(sensorId) != null)
  const zeros = reporting.filter(({ sensorId }) => loads.get(sensorId).total === 0)

  let cause
  if (inRange.length === 0) cause = 'RADIUS'
  else if (reporting.length === 0) cause = 'SILENT'
  else if (zeros.length === reporting.length) cause = 'ZERO'
  else cause = 'OK'

  return {
    block: `${u} -> ${v}`,
    street: e.street,
    length_m: e.length_m,
    sensors_in_range: inRange.length,
    reporting: reporting.length,
    density: e.density,
    rating: e.rating,
    opposing: e.opposing,
    cost: e.cost,
    cause,
    nearest_sensor_m: nearest ? nearest.distance_m : null,
    nearest_sensor: nearest ? nearest.name : null,
    // What this block WOULD read if the radius were wide enough to reach
    // its nearest sensor — the counterfactual that shows what you're missing.
    would_read: nearest && loads.get(nearest.id) ? loads.get(nearest.id).total : null,
    over_limit: e.density != null && e.density > tolerance,
    hidden_over_limit:
      e.density == null &&
      nearest != null &&
      loads.get(nearest.id) != null &&
      loads.get(nearest.id).total > tolerance,
  }
}

// --------------------------------------------------------------------------
// Route-level audit
// --------------------------------------------------------------------------

function auditOneRoute(route, tolerance, loads) {
  const rows = route.steps.map((s) => diagnoseBlock(s.from, s.to, tolerance, loads))

  const measured = rows.filter((r) => r.density != null)
  const positives = measured.filter((r) => r.density > 0)
  const truePeak = positives.length ? Math.max(...positives.map((r) => r.density)) : null

  // What the peak would be if unmeasured blocks were priced at their
  // nearest sensor instead of dropped from the calculation.
  const counterfactual = rows
    .map((r) => (r.density != null ? r.density : r.would_read))
    .filter((d) => d != null)
  const shadowPeak = counterfactual.length ? Math.max(...counterfactual) : null

  return {
    id: route.id,
    rows,
    summary: {
      id: route.id,
      blocks: rows.length,
      reported_peak: route.peak_density,
      reported_rating: route.rating,
      coverage_pct: route.coverage_pct,
      // reported_peak counts fabricated zeros; true_peak ignores them
      true_peak: truePeak,
      shadow_peak: shadowPeak,
      peak_understated_by:
        shadowPeak != null && route.peak_density != null
          ? shadowPeak - route.peak_density
          : null,
      blocks_over_limit: rows.filter((r) => r.over_limit).length,
      // The number that matters: blocks that exceed the slider but can
      // never fire the UI warning, because they score as unmeasured.
      hidden_over_limit: rows.filter((r) => r.hidden_over_limit).length,
      cause_RADIUS: rows.filter((r) => r.cause === 'RADIUS').length,
      cause_ZERO: rows.filter((r) => r.cause === 'ZERO').length,
      cause_SILENT: rows.filter((r) => r.cause === 'SILENT').length,
      cause_OK: rows.filter((r) => r.cause === 'OK').length,
    },
  }
}

// --------------------------------------------------------------------------
// Feed-level checks
// --------------------------------------------------------------------------

/** Fabricated zeros anywhere in the feed, not just on this route. */
function auditLoads(loads) {
  const zeros = []
  for (const [id, load] of loads) {
    if (load.total === 0) {
      zeros.push({ id, name: grid.SENSORS.get(id)?.description ?? '(unknown sensor)' })
    }
  }
  return {
    sensors_total: grid.SENSORS.size,
    sensors_reporting: loads.size,
    zero_readings: zeros.length,
    zero_sensors: zeros,
  }
}

/** How block coverage responds to the match radius, under the CURRENTLY ACTIVE match method. */
function radiusSweep() {
  const sensors = [...grid.SENSORS.values()]
  return RADIUS_SWEEP.map((radius) => {
    let covered = 0
    for (const [u, v] of grid.EDGES) {
      const hit = sensors.some((s) => grid.distanceToBlock(s.lat, s.lng, u, v) <= radius)
      if (hit) covered += 1
    }
    return {
      radius_m: radius,
      blocks_covered: covered,
      total_blocks: grid.EDGES.length,
      coverage_pct: Math.round((100 * covered) / grid.EDGES.length),
      current: radius === grid.SENSOR_RADIUS_M,
    }
  })
}

/**
 * The number that actually matters: how many blocks get a real reading
 * under the OLD midpoint-only matching vs the NEW nearest-point-on-segment
 * matching, against current loads. Used by CoverageDebugPanel.vue for
 * exactly this comparison.
 */
export function segmentVsMidpointCoverage(loads) {
  const before = grid.getMatchMethod()
  const coveredUnder = (method) => {
    grid.setMatchMethod(method)
    let covered = 0
    for (const [u, v] of grid.EDGES) {
      const hit = grid.sensorsForEdge(u, v).some(({ sensorId }) => loads.get(sensorId) != null)
      if (hit) covered += 1
    }
    return covered
  }

  const midpointCovered = coveredUnder('midpoint')
  const segmentCovered = coveredUnder('segment')
  grid.setMatchMethod(before) // restore whatever was active before this call

  const total = grid.EDGES.length
  return {
    total_blocks: total,
    old_midpoint_covered: midpointCovered,
    old_midpoint_pct: Math.round((100 * midpointCovered) / total),
    new_segment_covered: segmentCovered,
    new_segment_pct: Math.round((100 * segmentCovered) / total),
    blocks_gained: segmentCovered - midpointCovered,
  }
}

// --------------------------------------------------------------------------
// Entry point
// --------------------------------------------------------------------------

/**
 * @param origin      node name ('Spencer/LaTrobe') or a projectToEdge spec
 * @param destination same
 * @param tolerance   the slider value
 */
export async function auditRoute(origin, destination, tolerance = 65) {
  const loads = await crowd.getAllLoads()
  const src = crowd.source()
  const planned = routing.plan(origin, destination, tolerance, loads, src)

  const feed = auditLoads(loads)
  const audits = planned.data.routes.map((r) => auditOneRoute(r, tolerance, loads))
  const sweep = radiusSweep()
  const segmentVsMidpoint = segmentVsMidpointCoverage(loads)

  console.group(`Route audit — tolerance ${tolerance}/min, source "${src}", match method "${grid.getMatchMethod()}"`)

  console.log(
    `Feed: ${feed.sensors_reporting}/${feed.sensors_total} sensors reporting, ` +
      `${feed.zero_readings} reading exactly 0`,
  )
  if (feed.zero_readings > 0) {
    console.warn(
      'Literal zeros in the feed. A pedestrian sensor emits no row rather than a ' +
        'zero row, so these are almost certainly the `|| 0` coercion in clean(). ' +
        'Each one scores as the calmest possible block.',
    )
    console.table(feed.zero_sensors)
  }

  console.log(`Segment matching vs the old midpoint-only matching (against current loads):`)
  console.table([segmentVsMidpoint])

  console.log(`Match radius currently ${grid.SENSOR_RADIUS_M} m:`)
  console.table(sweep)

  for (const audit of audits) {
    console.group(`Route "${audit.id}"`)
    console.table(audit.rows, [
      'block', 'street', 'sensors_in_range', 'reporting', 'density',
      'rating', 'cause', 'nearest_sensor_m', 'would_read', 'hidden_over_limit',
    ])
    console.table([audit.summary])
    if (audit.summary.hidden_over_limit > 0) {
      console.warn(
        `${audit.summary.hidden_over_limit} block(s) on this route sit near a sensor ` +
          `reading above ${tolerance}/min but score as unmeasured, so they cannot ` +
          `trigger the over-limit warning.`,
      )
    }
    console.groupEnd()
  }

  console.groupEnd()

  return {
    tolerance,
    source: src,
    feed,
    segment_vs_midpoint: segmentVsMidpoint,
    radius_sweep: sweep,
    routes: audits,
    plan: planned,
  }
}

/** Diagnose a single block without planning a route. */
export async function auditBlock(u, v, tolerance = 65) {
  const loads = await crowd.getAllLoads()
  const row = diagnoseBlock(u, v, tolerance, loads)
  console.table([row])
  console.table(sensorsByDistance(u, v).slice(0, 5))
  return row
}

if (typeof window !== 'undefined') {
  window.auditRoute = auditRoute
  window.auditBlock = auditBlock
}

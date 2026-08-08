/**
 * Snap a planned corridor onto the real street network.
 *
 * The grid router decides *which streets* a route should take — that is where
 * the sensory model lives. But its geometry is a ~100 m street-model
 * interpolation, which visibly cuts across blocks when drawn on a real
 * basemap. This module takes the corridor's turn points and asks OSRM's
 * public walking router for the actual road geometry through them.
 *
 * Same deal as the basemap tiles: a keyless public service (FOSSGIS OSRM, the
 * router behind openstreetmap.org) stands in until the team's backend exists.
 * Every call is best-effort — on any failure the caller keeps the grid
 * geometry, so the app never depends on this being up.
 */

const OSRM_BASE = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot'
const TIMEOUT_MS = 6000

/** Corridors don't move, so a session-lifetime cache is safe and saves rate limit. */
const cache = new Map()

/**
 * Interior waypoints whose road-snap moved further than this are unreliable —
 * the grid model's coordinates are only ~100 m accurate, and a via that
 * snapped onto the wrong feature (a footbridge, a station walkway) forces the
 * route to detour out and back to touch it.
 */
const MAX_SNAP_DRIFT_M = 80

async function requestRoute(points, signal) {
  const key = points.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';')
  const response = await fetch(`${OSRM_BASE}/${key}?overview=full&geometries=geojson&steps=true`, {
    signal,
  })
  if (!response.ok) throw new Error(`OSRM ${response.status}`)
  const data = await response.json()
  if (data.code !== 'Ok' || !data.routes?.[0]) throw new Error(data.code ?? 'no route')
  return data
}

export async function matchToRoads(waypoints) {
  if (!waypoints || waypoints.length < 2) return null

  const cacheKey = waypoints.map((p) => `${p.lng.toFixed(5)},${p.lat.toFixed(5)}`).join(';')
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let data = await requestRoute(waypoints, controller.signal)

    // OSRM reports how far each input point moved when snapped to a road.
    // Interior vias that drifted too far pin the route to the wrong place —
    // drop them and route again with only the trustworthy ones. Endpoints
    // always stay: they are the user's actual origin and destination.
    const drifted = waypoints.filter((p, i) => {
      const interior = i > 0 && i < waypoints.length - 1
      return interior && (data.waypoints?.[i]?.distance ?? 0) > MAX_SNAP_DRIFT_M
    })
    if (drifted.length) {
      const trusted = waypoints.filter((p) => !drifted.includes(p))
      data = await requestRoute(trusted, controller.signal)
    }

    const route = data.routes[0]
    const coordinates = removeSpurs(
      route.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
    )

    const result = {
      coordinates,
      distanceM: Math.round(pathLength(coordinates)),
      steps: buildSteps(route.legs),
    }
    cache.set(cacheKey, result)
    return result
  } catch {
    // Unreachable, blocked, or rate-limited — the grid geometry stands.
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cut out-and-back spurs from a polyline.
 *
 * A forced via can make the route walk out to touch a point and return the
 * way it came. A sensible walking route never revisits a point, so whenever
 * the line comes back to (nearly) somewhere it has already been, everything
 * in between is a pointless excursion and is spliced out.
 */
function removeSpurs(coordinates) {
  // ~15 m in degrees at Melbourne's latitude.
  const EPS_LAT = 0.000135
  const EPS_LNG = 0.00017

  const near = (a, b) => Math.abs(a[0] - b[0]) < EPS_LAT && Math.abs(a[1] - b[1]) < EPS_LNG

  const out = [...coordinates]
  let changed = true
  while (changed) {
    changed = false
    scan: for (let i = 0; i < out.length - 2; i++) {
      // Furthest-first, so the whole spur goes in one splice.
      for (let j = Math.min(out.length - 1, i + 80); j > i + 1; j--) {
        if (near(out[i], out[j])) {
          out.splice(i + 1, j - i - 1)
          changed = true
          break scan
        }
      }
    }
  }
  return out
}

/** Length of a polyline in metres. */
function pathLength(coordinates) {
  const R = 6371000
  const toRad = (d) => (d * Math.PI) / 180
  let total = 0
  for (let i = 1; i < coordinates.length; i++) {
    const [lat1, lng1] = coordinates[i - 1]
    const [lat2, lng2] = coordinates[i]
    const dLat = toRad(lat2 - lat1)
    const dLng = toRad(lng2 - lng1)
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
    total += 2 * R * Math.asin(Math.sqrt(h))
  }
  return total
}

/**
 * Flatten OSRM's per-leg steps into our card format, merging consecutive
 * steps along the same street so the list reads like directions rather than
 * like a survey log.
 */
function buildSteps(legs) {
  const steps = []

  for (const leg of legs ?? []) {
    for (const step of leg.steps ?? []) {
      if (step.maneuver?.type === 'arrive' && steps.length) continue
      const name = step.name || 'walkway'

      const previous = steps[steps.length - 1]
      if (previous && previous.street === name) {
        previous.metres += step.distance
        continue
      }

      steps.push({ street: name, metres: step.distance, modifier: step.maneuver?.modifier })
    }
  }

  return steps
    .filter((s) => s.metres >= 10)
    .map((s, i) => ({
      instruction: i === 0 ? `Head along ${s.street}` : turnPhrase(s.modifier, s.street),
      detail: s.street,
      metres: Math.round(s.metres),
    }))
}

function turnPhrase(modifier, street) {
  if (modifier?.includes('left')) return `Turn left onto ${street}`
  if (modifier?.includes('right')) return `Turn right onto ${street}`
  return `Continue onto ${street}`
}

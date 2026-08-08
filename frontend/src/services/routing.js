/**
 * UI-generic route helpers.
 *
 * Route planning itself now lives in `services/engine/` (a port of the
 * Python backend) with the adapter in `services/api.js`. What's left here is
 * presentation-layer policy that doesn't belong to either: flow/score colour
 * bands, and the recommendation logic that decides which computed route to
 * highlight.
 */

/**
 * A fully saturated sensor reads this many people per minute. The comfort
 * slider's right-hand end means "any crowd".
 */
export const MAX_FLOW = 200

export const DEFAULT_MAX_FLOW = 100

export const WALK_SPEED_MPS = 1.35 // ~4.9 km/h, an unhurried pace

/**
 * The hard ceiling on detour length. Even when no route fits the user's
 * limit and we fall back to "least crowded", we never recommend a route more
 * than this much longer than the fastest one — a route nobody would actually
 * walk is not a recommendation.
 */
const ABSOLUTE_MAX_DETOUR = 0.8

/** Colour band for a people-per-minute figure. Matches the map legend. */
export function flowBand(flow) {
  if (flow < 60) return { id: 'quiet', label: 'Quiet', colour: '#12805c' }
  if (flow < 110) return { id: 'moderate', label: 'Moderate', colour: '#b8860b' }
  if (flow < 150) return { id: 'busy', label: 'Busy', colour: '#e8710a' }
  return { id: 'packed', label: 'Very busy', colour: '#d93025' }
}

/**
 * Coarse band for a 0-100 sensory score. Used by the landmarks list, whose
 * calmness ratings are curated on a 0-100 scale.
 */
export function scoreBand(score) {
  if (score < 30) return { id: 'calm', label: 'Calm', colour: '#12805c' }
  if (score < 50) return { id: 'moderate', label: 'Moderate', colour: '#b8860b' }
  if (score < 70) return { id: 'busy', label: 'Busy', colour: '#e8710a' }
  return { id: 'overwhelming', label: 'Overwhelming', colour: '#d93025' }
}

/**
 * Decide the recommendation.
 *
 * Simple, honest policy:
 *   - Among routes whose busiest point stays under the limit, recommend the
 *     fastest. The user gave us a ceiling, not a request for silence — once
 *     under it, extra quiet is not worth extra walking.
 *   - If nothing stays under the limit, recommend the lowest-peak route that
 *     is not an absurd detour, and say plainly that the limit can't be met.
 */
export function rankRoutes(routes, limit) {
  if (routes.length === 0) return routes

  const fastest = routes.reduce((a, b) => (b.durationMin < a.durationMin ? b : a))

  for (const route of routes) {
    route.underLimit = route.peakFlow <= limit
    route.recommended = false
    route.reason = null
    route.excludedBecause = null
  }

  const eligible = routes.filter((r) => r.underLimit)

  let winner
  const limitMet = eligible.length > 0
  if (limitMet) {
    winner = eligible.reduce((a, b) =>
      b.durationMin < a.durationMin || (b.durationMin === a.durationMin && b.peakFlow < a.peakFlow)
        ? b
        : a,
    )
  } else {
    // Nothing fits the limit. Least-crowded wins, within a sane detour.
    const walkable = routes.filter(
      (r) => r.durationMin <= fastest.durationMin * (1 + ABSOLUTE_MAX_DETOUR),
    )
    winner = walkable.reduce((a, b) => (b.peakFlow < a.peakFlow ? b : a))
  }

  winner.recommended = true

  const extraMin = winner.durationMin - fastest.durationMin
  if (!limitMet) {
    winner.reason = `No route stays under ${limit} people/min right now — this one has the lowest peak (${winner.peakFlow}/min at ${winner.peakAt}).`
  } else if (winner === fastest) {
    winner.reason = `Fastest option, and its busiest point is ${winner.peakFlow} people/min — under your ${limit} limit.`
  } else {
    winner.reason = `${extraMin} min longer than the fastest route, but stays under your limit (peak ${winner.peakFlow}/min vs ${fastest.peakFlow}/min).`
  }

  for (const route of routes) {
    if (route === winner) continue
    if (!route.underLimit) {
      route.excludedBecause = `peaks at ${route.peakFlow} people/min at ${route.peakAt} — over your ${limit} limit`
    }
  }

  // Recommended first, then within-limit options by speed, then the rest by
  // how badly they miss the limit.
  routes.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
    if (a.underLimit !== b.underLimit) return a.underLimit ? -1 : 1
    return a.underLimit ? a.durationMin - b.durationMin : a.peakFlow - b.peakFlow
  })

  return routes
}

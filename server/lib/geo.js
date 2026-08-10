/**
 * Geometry helpers — identical math to frontend/src/services/engine/grid.js.
 *
 * Kept as pure functions with no module-level state so they work the same
 * whether the caller built its graph from CSVs (browser) or from Postgres
 * (this server).
 */

const EARTH_R_M = 6_371_000.0

export function haversineM(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R_M * Math.asin(Math.sqrt(h))
}

export function bearingDeg(lat1, lng1, lat2, lng2) {
  const p1 = (lat1 * Math.PI) / 180
  const p2 = (lat2 * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const y = Math.sin(dLng) * Math.cos(p2)
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/**
 * Shortest distance (m) from (lat,lng) to the nearest point anywhere along
 * segment (aLat,aLng)-(bLat,bLng), not just its midpoint. Equirectangular
 * projection local to Melbourne, accurate to well under a metre at CBD scale.
 */
export function distanceToSegmentM(lat, lng, aLat, aLng, bLat, bLng) {
  const lat0 = (lat * Math.PI) / 180
  const kx = Math.cos(lat0) * 111_320.0
  const ky = 111_320.0
  const toXy = (la, ln) => [(ln - lng) * kx, (la - lat) * ky]

  const [ax, ay] = toXy(aLat, aLng)
  const [bx, by] = toXy(bLat, bLng)
  const dx = bx - ax
  const dy = by - ay
  const seg2 = dx * dx + dy * dy
  if (seg2 === 0) return Math.hypot(ax, ay)

  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / seg2))
  const px = ax + t * dx
  const py = ay + t * dy
  return Math.hypot(px, py)
}

export function opposes(myHeading, flowBearing) {
  if (flowBearing == null) return false
  const diff = Math.abs(myHeading - flowBearing) % 360
  return Math.min(diff, 360 - diff) > 90
}

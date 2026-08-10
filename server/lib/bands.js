/**
 * People-per-minute colour bands — same table as
 * frontend/src/services/routing.js's FLOW_BANDS, duplicated here so
 * /crowd/live can label sensors with the same `level` id the UI's local
 * fallback path already uses. Keep these two in sync if the thresholds ever
 * change.
 */
export const FLOW_BANDS = [
  { id: 'quiet', ceiling: 30 },
  { id: 'moderate', ceiling: 100 },
  { id: 'busy', ceiling: 150 },
  { id: 'packed', ceiling: Infinity },
]

export function flowBand(flow) {
  return FLOW_BANDS.find((band) => flow < band.ceiling) ?? FLOW_BANDS[FLOW_BANDS.length - 1]
}

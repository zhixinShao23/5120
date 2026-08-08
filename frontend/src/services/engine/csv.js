/**
 * Minimal CSV parsing — the browser has no pandas.read_csv.
 *
 * Handles quoted fields (sensors.csv has a few, e.g. descriptions with
 * commas) without pulling in a dependency for something this small.
 */

/** Parse CSV text into an array of row objects keyed by the header row. */
export function parseCsv(text) {
  const rows = parseRows(text)
  if (rows.length === 0) return []
  const header = rows[0]
  return rows.slice(1)
    .filter((r) => r.length > 1 || r[0] !== '')
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

function parseRows(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r') {
      // skip; \n (or end of input) closes the row
    } else if (c === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += c
    }
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Fetch a CSV file and parse it into row objects. Throws on any failure. */
export async function fetchCsv(url, options = {}) {
  const response = await fetch(url, options)
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
  return parseCsv(await response.text())
}

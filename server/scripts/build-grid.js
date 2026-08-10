/**
 * Pure computation of the Hoddle Grid's intersections and blocks — same
 * constants and bilinear interpolation as
 * frontend/src/services/engine/grid.js's buildNodes()/buildGraph(), kept
 * here as a standalone pure function (no DB, no fetch) so seed.js can
 * insert its output and a test can assert on it directly.
 */

import { haversineM, bearingDeg } from '../lib/geo.js'

const NS_STREETS = ['Spencer', 'King', 'William', 'Queen', 'Elizabeth',
  'Swanston', 'Russell', 'Exhibition', 'Spring']

const EW_MAJOR = ['Flinders', 'Collins', 'Bourke', 'Lonsdale', 'LaTrobe']
const EW_LITTLE = {
  Flinders: 'FlindersLane',
  Collins: 'LittleCollins',
  Bourke: 'LittleBourke',
  Lonsdale: 'LittleLonsdale',
}

const INCLUDE_LITTLE_STREETS = true

function ewStreets() {
  if (!INCLUDE_LITTLE_STREETS) return [...EW_MAJOR]
  const out = []
  EW_MAJOR.forEach((major, i) => {
    out.push(major)
    if (EW_LITTLE[major] && i < EW_MAJOR.length - 1) out.push(EW_LITTLE[major])
  })
  return out
}

const EW_STREETS = ewStreets()
const LITTLE_NAMES = new Set(Object.values(EW_LITTLE))

const CORNERS = {
  'Spencer,Flinders': [-37.82107, 144.95505],
  'Spring,Flinders': [-37.81526, 144.97488],
  'Spencer,LaTrobe': [-37.81317, 144.95142],
  'Spring,LaTrobe': [-37.80747, 144.97126],
}

function buildNodes() {
  const sw = CORNERS[`${NS_STREETS[0]},${EW_STREETS[0]}`]
  const se = CORNERS[`${NS_STREETS[NS_STREETS.length - 1]},${EW_STREETS[0]}`]
  const nw = CORNERS[`${NS_STREETS[0]},${EW_STREETS[EW_STREETS.length - 1]}`]
  const ne = CORNERS[`${NS_STREETS[NS_STREETS.length - 1]},${EW_STREETS[EW_STREETS.length - 1]}`]

  const nodes = new Map()
  NS_STREETS.forEach((ns, i) => {
    const u = i / (NS_STREETS.length - 1)
    EW_STREETS.forEach((ew, j) => {
      const v = j / (EW_STREETS.length - 1)
      const lat = (1 - u) * (1 - v) * sw[0] + u * (1 - v) * se[0]
        + (1 - u) * v * nw[0] + u * v * ne[0]
      const lng = (1 - u) * (1 - v) * sw[1] + u * (1 - v) * se[1]
        + (1 - u) * v * nw[1] + u * v * ne[1]
      const name = `${ns}/${ew}`
      nodes.set(name, [Math.round(lat * 1e6) / 1e6, Math.round(lng * 1e6) / 1e6])
    })
  })
  return nodes
}

/** One row per block — a single directed representative (u -> v); `blocks` is stored undirected. */
function buildBlocks(nodes) {
  const blocks = []

  const link = (u, v, street) => {
    const [aLat, aLng] = nodes.get(u)
    const [bLat, bLng] = nodes.get(v)
    blocks.push({
      from: u,
      to: v,
      street,
      isLittle: LITTLE_NAMES.has(street),
      lengthM: Math.round(haversineM(aLat, aLng, bLat, bLng) * 10) / 10,
      bearingDeg: Math.round(bearingDeg(aLat, aLng, bLat, bLng) * 10) / 10,
    })
  }

  for (const ns of NS_STREETS) {
    for (let i = 0; i < EW_STREETS.length - 1; i++) {
      link(`${ns}/${EW_STREETS[i]}`, `${ns}/${EW_STREETS[i + 1]}`, ns)
    }
  }
  for (const ew of EW_STREETS) {
    for (let i = 0; i < NS_STREETS.length - 1; i++) {
      link(`${NS_STREETS[i]}/${ew}`, `${NS_STREETS[i + 1]}/${ew}`, ew)
    }
  }
  return blocks
}

/** { nodes: Map<name, [lat,lng]>, blocks: [{from,to,street,isLittle,lengthM,bearingDeg}] } */
export function buildGrid() {
  const nodes = buildNodes()
  const blocks = buildBlocks(nodes)
  return { nodes, blocks }
}

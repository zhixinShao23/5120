# QuietWay — Iteration Build Documentation

A chronological record of how this project was built, reconstructed from the git
history (`git log --all --graph`) plus firsthand detail for the iterations built
in this session. QuietWay is a sensory-friendly walking route planner for the
Melbourne CBD: it scores routes by live pedestrian crowd density (not just
distance) and surfaces quiet refuges along the way.

Contributors referenced below: **Priyan Sabarish** (routing/location engine,
backend API, deployment), **Zhixin Shao** (project structure, WebUI), **Ritvik
Sharma** (real-time data streaming, first database attempt).

---

## Iteration 1 — Project scaffolding & data contracts
**2026-08-04 – 2026-08-05**

The repo starts as a shared skeleton so three people can build independent
pieces without stepping on each other.

- Project structure and README created (`46324b8`, `ceeec7e`, and three
  `Create project structure` commits) — establishes the `backend/`,
  `frontend/`, `data/` folder split used for the rest of the project.
- **Crowd data contract**, stubbed out (`8619053`) — defines the shape the
  crowd engine would eventually return, before it existed, so the routing and
  UI work could be built against a known interface.
- **Sample grid for edge-to-sensor mapping** (`b435b3a`) — the first pass at
  the idea that every walkable street block should know which pedestrian
  sensors are near it, which becomes the core of `backend/grid.py` later.

**Why this order**: contracts and structure before implementation, so the
three engines (location, crowd, routing) being built in parallel over the next
few days have a stable interface to build against instead of a moving target.

---

## Iteration 2 — Core engines: crowd, location, WebUI
**2026-08-06 – 2026-08-08**

Three parallel branches (`crowd_engine`, `location_engine`, `WebUI`), each
merged back to `main` via a pull request once ready.

- **`WebUI` branch → PR #4** (Zhixin Shao): the Vue 3 + Vite frontend shell —
  `App.vue`, and a first set of components (`AlertBanner`, `AppIcon`,
  `CategoryChips`, `CrowdLegend`, `CrowdLimit`, and more), ~1,000+ lines
  across the initial commit. This is the UI shell the rest of the project's
  features get wired into.
- **`crowd_engine` branch → PR #2**: `backend/crowd.py` (308 lines) — reads
  City of Melbourne pedestrian sensor data, plus the two CSVs that back it,
  `data/sensors.csv` (135 sensors) and `data/snapshot.csv` (701 cached
  readings, for when the live feed is unreachable).
- **`location_engine` branch → PR #1, then #3**: `backend/grid.py` grows from
  a stub into the real spatial engine (`92440ef`, then +217/-17 lines in
  `e51fe2b`) — builds the Hoddle Grid's intersections and blocks by bilinear
  interpolation over four corner coordinates, matches sensors to the blocks
  near them, and (in the later PR) adds sensory refuge locations from the
  council's POI dataset.

**Why this order**: crowd data and spatial geometry are independent concerns
that routing needs *both* of — building them as separate engines with a
narrow, previously-agreed interface (Iteration 1's contract) let two people
work on them at once.

---

## Iteration 3 — Routing engine & full-stack integration
**2026-08-08**

With crowd and location data available, routing — the actual point of the
app — gets built and wired to the UI in the same day.

- **`route_engine` branch**: `backend/routing.py` (392 lines) and
  `backend/scoring.py` (298 lines) — Dijkstra over the street grid, weighted
  by a sensory cost function (`cost = length_m × (1 + w_density × density +
  w_opposing × opposing)`), producing calm/quiet/fast route options.
  `backend/main.py` (170 lines) exposes this as a FastAPI service the
  frontend can call.
- **`ad4e7ec` — "merged routing logic + frontend"**: routing and the WebUI
  shell come together — this is the point the app becomes clickable
  end-to-end for the first time (search → plan → see routes on a map).

**Why this order**: routing is the feature the other two engines exist to
serve, so it's built last among the three and integrated with the UI
immediately rather than left on its own branch.

---

## Iteration 4 — Real-time data streaming & first database attempt
**2026-08-09**

- **`e225ab6` — routing bug fixes** (Priyan Sabarish).
- **`6de4dbe` — "adding the api changes for database"** (Ritvik Sharma, on
  `f/stream-realtime-data`): the first attempt at a real backend —
  `database/main.py` (219 lines, a FastAPI service intended to read from AWS
  RDS Postgres) and a matching rewrite of `frontend/src/services/api.js`
  (+107/−65 lines) so the frontend would call a real API instead of only the
  in-browser engine.

**What this iteration got right**: establishing that the frontend should
*try* a real backend and *fall back* to the local engine on failure — that
seam (`request()` in `api.js`) survives essentially unchanged through every
later iteration.

**What surfaced in the next iteration**: `database/main.py`'s queries didn't
match any schema that existed in the repo yet — it queried `landmarks`,
`places`, and `weather` tables, and a `sensors` table with `name`/`count`/
`updated_at` columns, none of which existed. There was also no schema file
and no seed path from the CSVs into a database at all. The backend described
in this iteration could not have run against real data yet.

---

## Iteration 5 — Rebuilding the backend to match the schema
**2026-08-10 · this session**

This is where the gap from Iteration 4 gets closed. Starting point: a
`database/schema.sql` existed (evidently drafted separately, describing
`intersections`, `blocks`, `sensors`, `sensor_readings`,
`points_of_interest`, plus optional `users`/`favorite_places`/
`route_requests`), but nothing in the repo actually queried it correctly, and
nothing populated it.

- **Diagnosed the mismatch**: `database/main.py`'s queries didn't match
  `schema.sql`'s actual tables/columns at all (see Iteration 4's note above).
- **Added the missing `weather_observations` table** to `schema.sql`.
- **Built `server/`, a Node/Express API from scratch**, matching the schema
  exactly this time:
  - `server/lib/{grid,scoring,routing,geo,bands}.js` — a deliberate port of
    the frontend's own local routing engine (`frontend/src/services/engine/`),
    since that engine can't run under Node (it builds its graph via a
    browser-only relative `fetch`). Same constants, same algorithms, sourced
    from Postgres rows instead of CSVs.
  - `server/index.js` — implements every endpoint `api.js` expects
    (`/health`, `/crowd/live`, `/weather/current`, `/places`, `/landmarks`,
    `/refuges`, `/routes/plan`), returning non-2xx on failure so the
    frontend's existing local-fallback logic actually triggers correctly
    (the old pattern of returning `{routes: []}` on error was silently wrong
    — an empty array is truthy in JS, so the frontend would have read a
    failure as "success, zero results").
  - `server/scripts/seed.js` — loads `data/sensors.csv`, `data/snapshot.csv`,
    `data/landmarks_poi_noise_cleaned.csv`, and the frontend's mock
    places/landmarks/weather into the schema. Verified output: 81
    intersections, 144 blocks, 134 sensors, 158 block–sensor links, 700
    sensor readings, 116 points of interest — matching the numbers
    `backend/grid.py`'s own comments predicted.
  - `frontend/src/services/api.js` — fixed `planRoute()` to apply the same
    UI formatting to server-sourced and locally-computed routes, instead of
    assuming the server pre-formats UI-ready objects (it didn't).
- **Verified two ways**: `server/test/integration.test.js` loads the real
  `schema.sql` into `pg-mem` (an in-memory Postgres-compatible engine — no
  local Postgres/Docker was available in this environment) and exercises
  every endpoint — 10/10 passing. Then, given real AWS RDS credentials,
  connected directly, discovered `test_user` lacked `CREATE` privilege
  (Postgres 15+'s default), used the master user *transiently* (never
  written to disk) to grant `test_user` the DML rights it needed, seeded the
  real database, and confirmed identical results against the live RDS
  instance.

**Why this matters for the log**: this iteration didn't add a feature so
much as make Iteration 4's feature actually work — the difference between "a
backend exists" and "the backend one API call away serves real, seeded data."

---

## Iteration 6 — Homepage, navigation & dark mode
**2026-08-10 · this session**

Until this point the app was a single full-viewport map view with no other
pages. This iteration adds the parts a visitor sees before ever opening the
map.

- **`vue-router`** introduced for the first time — `/` (home), `/map`,
  `/about`. The previous `App.vue` map experience moved unchanged into
  `views/MapPage.vue`.
- **`views/HomePage.vue`** — built from a supplied mockup, wired to *real*
  data rather than the mockup's static numbers: a status pill computed from
  live sensor levels, origin/destination search reusing the existing
  `PlaceInput` autocomplete, a Low/Medium/High sensitivity toggle mapped to
  the routing engine's `maxFlow` tolerance, and a widgets row (live map
  preview, real crowd alerts, nearest real refuge computed via haversine
  distance). A "Find route" click hands the picked origin/destination off to
  `/map` via query params, which `MapPage.vue` picks up on mount.
- **`components/NavBar.vue`**, **`views/AboutPage.vue`** — new.
- **Dark mode**: `theme.js` (shared reactive state, persisted to
  `localStorage`), an inline script in `index.html` that sets the theme
  *before first paint* to avoid a flash of the wrong theme, defaulting to
  `prefers-color-scheme` on first visit. Most components were using
  hardcoded hex colors instead of the app's existing CSS custom properties,
  so dark mode required introducing new semantic tokens (`--divider`,
  `--surface-hover`, `--calm-soft`, `--accent-fill` vs `--accent`,
  `--strong-fill`) and replacing the literals across ~10 components. The map
  itself goes dark too — CARTO's `dark_all` tile set swaps in live, brightened
  via a CSS filter (`brightness(1.45) contrast(0.85) saturate(1.15)`) since
  Dark Matter's default roads/labels are quite muted, plus a bumped default
  zoom (15→16) so street labels render bigger.
- **Fixes made in response to review**: removed the map's default
  Southern-Cross-to-Parliament demo journey (map now opens empty unless
  arriving via the homepage's "Find route" handoff); fixed the homepage's
  search fields ballooning to ~390px wide on large screens (`1fr` grid
  columns replaced with a `minmax(0, 340px)` cap).

**Verified in the browser** at each step — not just visually: computed
styles checked via JS (`getComputedStyle`) to confirm dark-mode colors and
map tile URLs were actually applying, not just assumed from the CSS source.

---

## Iteration 7 — Production polish
**2026-08-10 · this session**

- Removed `CoverageDebugPanel.vue` (a "sensor matching debug" panel useful
  during Iteration 2's development, not appropriate for a demo/production
  build) and its wiring in `MapPage.vue`.
- Added a favicon (`frontend/public/favicon.svg`) reusing the same leaf mark
  as the nav bar logo, so the browser tab has a real icon instead of the
  default blank one.

---

## Iteration 8 — Deployment & live-data correctness fix
**2026-08-10 · this session**

- **Hosting config added**: `frontend/vercel.json` (SPA rewrite rule, so
  `vue-router`'s history-mode routes like `/map` don't 404 on a direct load)
  and `render.yaml` (a Render Blueprint for `server/` as an always-on Node
  service — deliberately *not* Vercel serverless functions, since
  `server/index.js` pools Postgres connections via `pg.Pool`, which doesn't
  fit Vercel's stateless, highly-parallel invocation model without extra
  work like PgBouncer).
- **Deployed**: backend to Render, frontend to Vercel (via a personal-account
  copy of the repo, since the deploying account didn't have direct push
  access to the origin repo — a GitHub App permissions issue, not a code
  issue).
- **Bug found post-deploy**: the live site showed a busy CBD at 10:30 PM,
  when the real conditions were quiet. Root cause — `server/index.js` only
  ever read `sensor_readings`, seeded *once* from a static snapshot and
  never refreshed, and worse, stamped every response with the *current
  server time* instead of the data's actual timestamp, so 3-day-old
  evening-peak numbers were reported as "just now."
- **Fix (`89a7f6b`)**: `server/lib/liveCrowd.js` ports the live-fetch half of
  `frontend/src/services/engine/crowd.js` to the server (the half that isn't
  browser-specific — only its CSV-fallback path is). `loadCrowd()` now tries
  the live City of Melbourne feed first, cached in memory for 60 seconds so
  concurrent pollers share one fetch, falling back to the DB snapshot only
  if the feed is unreachable. `observedAt`/`updatedAt` now reflect the
  data's real `sensing_datetime`, so a fallback reading is honestly reported
  as stale instead of masquerading as fresh.
- **Verified against the real feed**: fetched the live external API directly
  (92 sensors, max count 45 — genuinely quiet) and compared against the
  deployed backend's own response after the fix (`source: "live"`, same
  order-of-magnitude counts) before merging.

---

## Summary table

| Iteration | Dates | Focus | Key artifacts |
|---|---|---|---|
| 1 | Aug 4–5 | Scaffolding & contracts | project structure, crowd data contract, sensor-mapping prototype |
| 2 | Aug 6–8 | Core engines | `backend/crowd.py`, `backend/grid.py`, WebUI shell |
| 3 | Aug 8 | Routing + integration | `backend/routing.py`, `backend/scoring.py`, first clickable app |
| 4 | Aug 9 | Real-time data, first DB attempt | `database/main.py` (v1, mismatched schema) |
| 5 | Aug 10 | Backend rebuild | `server/` (Node/Express + Postgres), schema fix, seed script, RDS verification |
| 6 | Aug 10 | Homepage, nav, dark mode | `router.js`, `HomePage.vue`, `theme.js`, dark map tiles |
| 7 | Aug 10 | Production polish | favicon, debug panel removed |
| 8 | Aug 10 | Deployment | `vercel.json`, `render.yaml`, live Vercel + Render deploy, live-crowd-data fix |

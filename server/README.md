# QuietWay API

A Postgres-backed implementation of the endpoints [`frontend/src/services/api.js`](../frontend/src/services/api.js) calls (`/health`, `/crowd/live`, `/weather/current`, `/places`, `/landmarks`, `/refuges`, `/routes/plan`), against [`database/schema.sql`](../database/schema.sql).

The routing/scoring/heatmap logic in [`lib/`](lib) is a deliberate parallel implementation of [`frontend/src/services/engine/`](../frontend/src/services/engine) (same constants, same algorithms) rather than a shared import — that engine builds its graph via a browser-only relative `fetch` at module load, so it can't run under Node as-is. `lib/grid.js` builds the identical in-memory shape from Postgres rows instead.

## Setup

```bash
createdb quietway   # or use an existing Postgres/RDS database
psql quietway -f ../database/schema.sql
cp .env.example .env   # fill in DB_HOST/DB_USER/DB_PASSWORD/etc.
npm install
npm run seed   # loads data/*.csv + frontend/src/mock/data.js into the DB
npm start       # listens on PORT (default 8000)
```

Then point the frontend at it:

```bash
cd ../frontend
VITE_API_BASE=http://localhost:8000 npm run dev
```

## Testing

No Docker/Postgres was available in the environment this was built in, so `npm test` runs the same schema + seed + every endpoint against [`pg-mem`](https://github.com/oguimbal/pg-mem), an in-memory Postgres-compatible engine, instead. It genuinely executes `schema.sql` and every query this API makes — proving the two agree — but it isn't a substitute for running once against real Postgres before deploying (pg-mem supports a subset of SQL; e.g. it doesn't implement window functions, which is why `index.js`'s crowd query uses `DISTINCT ON` plus a JS-side reduction instead of a `ROW_NUMBER() OVER (...)`).

```bash
npm test
```

## Notes

- `npm run seed` is destructive — it `TRUNCATE`s `intersections`, `blocks`, `sensors`, `block_sensors`, `sensor_readings`, `points_of_interest`, and `weather_observations` before reloading, so it's safe to re-run but will wipe anything else stored in those tables.
- `points_of_interest` folds three sources into one table (see `database/schema.sql`'s own comment on this): plain searchable places (`kind` set, nothing else), curated landmarks (`sensory_score` set), and noise-rated refuges (`noise_level` set). `/places` searches all of them by name; `/landmarks` and `/refuges` filter by whichever column is set.
- `users` / `favorite_places` / `route_requests` exist in the schema but nothing here writes to them — they're for a future accounts feature, per the schema's own comment.

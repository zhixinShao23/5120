-- ============================================================================
-- QuietWay — PostgreSQL schema
--
-- Covers everything the app currently reads from CSV/mock data, organised
-- into three groups:
--   1. STREET GRID    — intersections & blocks (derived/computed data)
--   2. CROWD DATA     — pedestrian sensors & their readings (source data)
--   3. PLACES         — searchable destinations / landmarks / refuges
-- Plus an OPTIONAL fourth group for accounts and saved trips, which nothing
-- in the app needs today but is the natural next step once there's a real
-- backend.
--
-- Notes for whoever builds the API on top of this:
--   - intersections/blocks are DERIVED data, not source data. They come from
--     backend/grid.py's bilinear interpolation over 4 corner coordinates +
--     a street list — there is no CSV for them. Run that generation once
--     (or port it to SQL/a seed script) and INSERT the result; don't expect
--     a data file to import.
--   - sensors / sensor_readings map directly onto data/sensors.csv and
--     data/snapshot.csv — those already exist and can be imported as-is.
--   - This schema is geo-heavy (nearest-intersection lookups, "project onto
--     nearest block" for arbitrary tap points, radius searches for sensors
--     near a block). Plain lat/lng columns work, but PostGIS makes those
--     queries much cheaper — see the bottom of this file for the optional
--     upgrade.
-- ============================================================================


-- ============================================================================
-- 1. STREET GRID
-- ============================================================================

-- Every named intersection in the Hoddle Grid (including "little" streets —
-- Flinders Lane, Little Collins, Little Bourke, Little Lonsdale).
-- Primary key is the human name ("Spencer/Flinders") rather than a surrogate
-- id, because that's already how the routing code (JS and Python) addresses
-- nodes — using the same key end-to-end avoids a translation layer.
CREATE TABLE intersections (
    id          TEXT PRIMARY KEY,       -- e.g. 'Spencer/Flinders'
    street_ns   TEXT NOT NULL,          -- north-south street, e.g. 'Spencer'
    street_ew   TEXT NOT NULL,          -- east-west street, e.g. 'Flinders'
    lat         DOUBLE PRECISION NOT NULL,
    lng         DOUBLE PRECISION NOT NULL,
    UNIQUE (street_ns, street_ew)
);

-- One row per walkable block (the street segment between two adjacent
-- intersections). Stored once per block, undirected — the router derives
-- both directions of travel from a single row at query time.
CREATE TABLE blocks (
    id                 BIGSERIAL PRIMARY KEY,
    from_intersection  TEXT NOT NULL REFERENCES intersections(id),
    to_intersection    TEXT NOT NULL REFERENCES intersections(id),
    street_name        TEXT NOT NULL,       -- e.g. 'Bourke' or 'LittleCollins'
    is_little_street   BOOLEAN NOT NULL DEFAULT FALSE,
    length_m           NUMERIC(8, 1) NOT NULL,
    bearing_deg        NUMERIC(5, 1) NOT NULL,  -- compass heading walking from -> to
    CONSTRAINT blocks_distinct_endpoints CHECK (from_intersection <> to_intersection),
    UNIQUE (from_intersection, to_intersection)
);

CREATE INDEX idx_blocks_from ON blocks(from_intersection);
CREATE INDEX idx_blocks_to   ON blocks(to_intersection);


-- ============================================================================
-- 2. CROWD DATA
-- ============================================================================

-- Pedestrian counting sensors — static metadata, maps 1:1 onto data/sensors.csv.
-- id is the City of Melbourne's own location_id, kept as the natural key so
-- readings can reference it directly and nothing needs re-mapping on import.
CREATE TABLE sensors (
    id           INTEGER PRIMARY KEY,        -- location_id from the open data feed
    description  TEXT NOT NULL,              -- e.g. 'Melbourne Central'
    lat          DOUBLE PRECISION NOT NULL,
    lng          DOUBLE PRECISION NOT NULL,
    bearing_d1   NUMERIC(5, 1),               -- compass heading of "direction 1", nullable
    bearing_d2   NUMERIC(5, 1),
    status       TEXT NOT NULL DEFAULT 'A'    -- 'A' = active, matches the source feed
);

-- Which sensors are within range of which block, nearest first. This is
-- derived (computed from distance at load time, same as
-- backend/grid.py:map_edges_to_sensors) but worth persisting since it's
-- expensive to recompute on every request and rarely changes.
CREATE TABLE block_sensors (
    block_id    BIGINT  NOT NULL REFERENCES blocks(id)   ON DELETE CASCADE,
    sensor_id   INTEGER NOT NULL REFERENCES sensors(id)  ON DELETE CASCADE,
    distance_m  NUMERIC(6, 1) NOT NULL,
    PRIMARY KEY (block_id, sensor_id)
);

CREATE INDEX idx_block_sensors_by_block ON block_sensors(block_id, distance_m);

-- Time-series pedestrian counts. Maps onto data/snapshot.csv / the live
-- Melbourne "Pedestrian Counting System - Past Hour" feed. This is the one
-- table that grows continuously — if you're only ever asking "what's the
-- latest reading per sensor", consider pruning rows older than a day or two,
-- or partitioning by sensing_datetime once volume gets real.
CREATE TABLE sensor_readings (
    id                 BIGSERIAL PRIMARY KEY,
    sensor_id          INTEGER NOT NULL REFERENCES sensors(id) ON DELETE CASCADE,
    sensing_datetime   TIMESTAMPTZ NOT NULL,
    direction_1_count  INTEGER NOT NULL CHECK (direction_1_count >= 0),
    direction_2_count  INTEGER NOT NULL CHECK (direction_2_count >= 0),
    total_count        INTEGER NOT NULL CHECK (total_count >= 0),
    source             TEXT NOT NULL DEFAULT 'live',  -- 'live' | 'snapshot'
    UNIQUE (sensor_id, sensing_datetime)
);

-- The hot query is always "latest reading per sensor" — this index makes
-- that an index-only scan instead of a sort over the whole table.
CREATE INDEX idx_sensor_readings_latest ON sensor_readings (sensor_id, sensing_datetime DESC);


-- ============================================================================
-- 3. PLACES — search, landmarks, and sensory refuges
--
-- The frontend currently has THREE overlapping mock/CSV sources for this:
-- generic searchable PLACES, curated LANDMARKS (sensory score + quiet hours
-- + blurb), and backend refuges (landmarks_poi_noise_cleaned.csv, noise
-- level only). They're all "a point of interest with an optional sensory
-- rating" — worth consolidating into one table with a `kind` column rather
-- than keeping three near-duplicate ones in sync.
-- ============================================================================

CREATE TABLE points_of_interest (
    id             TEXT PRIMARY KEY,       -- slug, e.g. 'state-library'
    name           TEXT NOT NULL,
    kind           TEXT NOT NULL,          -- 'transport' | 'landmark' | 'park' | 'market' |
                                            -- 'culture' | 'shopping' | 'education' | 'pin' | ...
    lat            DOUBLE PRECISION NOT NULL,
    lng            DOUBLE PRECISION NOT NULL,

    -- Sensory-rating fields — null for plain searchable places that have no
    -- curated rating yet (e.g. an autocomplete-only entry).
    sensory_score  SMALLINT CHECK (sensory_score BETWEEN 0 AND 100), -- lower = calmer
    noise_level    TEXT,                   -- coarse band, e.g. 'low' | 'medium' | 'high'
    quiet_hours    TEXT,                   -- free text, e.g. '9:00–11:00, 16:00–18:00'
    features       TEXT[],                 -- e.g. '{Quiet reading rooms, Soft lighting}'
    blurb          TEXT
);

CREATE INDEX idx_poi_kind ON points_of_interest(kind);
CREATE INDEX idx_poi_sensory_score ON points_of_interest(sensory_score);

-- Cheap trigram search for the autocomplete box. Requires pg_trgm — see the
-- extensions note at the bottom.
-- CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- CREATE INDEX idx_poi_name_trgm ON points_of_interest USING GIN (name gin_trgm_ops);


-- ============================================================================
-- 4. WEATHER
--
-- One row per observation. Maps onto frontend/src/mock/data.js's WEATHER
-- object, which is the shape /api/weather/current must return. Small and
-- low-volume enough that "latest row" is a fine query pattern here too.
-- ============================================================================

CREATE TABLE weather_observations (
    id             BIGSERIAL PRIMARY KEY,
    temp_c         NUMERIC(4, 1) NOT NULL,
    condition      TEXT NOT NULL,
    icon           TEXT,                    -- e.g. 'cloud', matches AppIcon names
    wind_kph       NUMERIC(4, 1),
    rain_chance    NUMERIC(3, 2) CHECK (rain_chance BETWEEN 0 AND 1),
    uv_index       NUMERIC(3, 1),
    observed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_weather_observed_at ON weather_observations (observed_at DESC);


-- ============================================================================
-- 5. OPTIONAL — accounts & trip history
--
-- Nothing in the app needs these today (every user is anonymous, nothing is
-- saved between sessions). Include them only if you want accounts, saved
-- favourites, or a route history feature; otherwise skip this section.
-- ============================================================================

CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- needs pgcrypto, see below
    email              TEXT UNIQUE NOT NULL,
    display_name       TEXT,
    default_max_flow   SMALLINT NOT NULL DEFAULT 100,  -- their usual crowd-tolerance slider value
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE favorite_places (
    user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    poi_id    TEXT NOT NULL REFERENCES points_of_interest(id) ON DELETE CASCADE,
    label     TEXT,          -- optional override, e.g. "Home", "Work"
    added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, poi_id)
);

-- One row per route the app actually planned and showed someone. Storing
-- the full computed route as JSONB avoids re-running the router just to
-- show trip history, at the cost of it going stale if crowd levels move on.
CREATE TABLE route_requests (
    id                 BIGSERIAL PRIMARY KEY,
    user_id            UUID REFERENCES users(id) ON DELETE SET NULL,  -- null = anonymous
    origin_lat         DOUBLE PRECISION NOT NULL,
    origin_lng         DOUBLE PRECISION NOT NULL,
    destination_lat    DOUBLE PRECISION NOT NULL,
    destination_lng    DOUBLE PRECISION NOT NULL,
    tolerance          SMALLINT NOT NULL,       -- people/min ceiling requested
    recommended_route  TEXT,                    -- 'calm' | 'quiet' | 'fast'
    distance_m         INTEGER,
    duration_min       INTEGER,
    peak_density       INTEGER,
    route_json         JSONB,                   -- full plan() response, for replay/debugging
    requested_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_route_requests_user ON route_requests(user_id, requested_at DESC);


-- ============================================================================
-- Recommended extensions
-- ============================================================================

-- gen_random_uuid() used above for users.id:
-- CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Strongly recommended given how geo-heavy this app is: PostGIS turns
-- "nearest intersection to a tapped point", "sensors within 70m of this
-- block", and "POIs within 800m of here" from application-code loops (the
-- current haversine-in-a-for-loop approach in grid.py/grid.js) into indexed
-- database queries.
--
-- CREATE EXTENSION IF NOT EXISTS postgis;
--
-- Example of the upgrade path once installed — add a generated geography
-- column + spatial index alongside the plain lat/lng (keep both; lat/lng is
-- still what the API sends/receives):
--
--   ALTER TABLE intersections ADD COLUMN geog GEOGRAPHY(Point, 4326)
--     GENERATED ALWAYS AS (ST_MakePoint(lng, lat)::geography) STORED;
--   CREATE INDEX idx_intersections_geog ON intersections USING GIST (geog);
--
--   -- nearest intersection to an arbitrary point:
--   SELECT id FROM intersections
--   ORDER BY geog <-> ST_MakePoint(:lng, :lat)::geography
--   LIMIT 1;
--
-- Same pattern applies to sensors, points_of_interest, and blocks (via a
-- LINESTRING geography instead of a Point) if you want ST_DWithin-based
-- radius search instead of the current fixed SENSOR_RADIUS_M loop.

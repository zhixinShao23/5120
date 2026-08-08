"""
Location engine (grid.py) — Person B.

Owns everything spatial. Has no opinion about whether a street is busy; it only
answers geometry questions:

    - which intersections exist, and where
    - which intersections are adjacent along a street
    - how long each block is, and what heading you face walking it
    - which sensor measures each block

Nodes are STREET INTERSECTIONS, edges are the block of street between two
adjacent intersections. This guarantees every edge lies along a real street,
so routes are walkable directions rather than lines across buildings.

Public surface used by scoring.py / routing.py:
    NODES, GRAPH, EDGE_SENSOR
    nearest_node(lat, lng)
    edge_length(u, v)
    edge_bearing(u, v)
    sensor_for_edge(u, v)
    coords(path)
    opposes(heading, flow_bearing)
    diagnostics()
"""

from __future__ import annotations

from dataclasses import dataclass
from math import asin, atan2, cos, degrees, radians, sin, sqrt

import networkx as nx
import pandas as pd

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

SENSORS_CSV = "data/sensors.csv"

# A block is measured by the nearest sensor to its midpoint, but only if that
# sensor is genuinely close. Beyond this the block is UNMEASURED, which the
# scoring engine must penalise rather than treat as quiet.
#
# Melbourne has "little" streets (Flinders Lane, Little Collins, Little Bourke)
# roughly halfway between the majors, so a tight radius keeps blocks matched to
# sensors actually on them. But the interpolated grid sits slightly wide of the
# real streets, so 90 m leaves most blocks unmeasured. 130 m trades a little
# match precision for far better coverage. Check sensor_mismatches() after
# changing this, and prefer the smallest value that keeps coverage above ~60%.
SENSOR_RADIUS_M = 70.0

# Hoddle Grid, west to east then south to north.
NS_STREETS = ["Spencer", "King", "William", "Queen", "Elizabeth",
              "Swanston", "Russell", "Exhibition", "Spring"]

# The majors, south to north. The Hoddle Grid also carries a "little" street
# roughly midway between each pair - Flinders Lane, Little Collins, Little
# Bourke, Little Lonsdale - which are genuinely quieter than the majors and are
# the routes locals actually use.
#
# Including them doubles the east-west resolution: 81 intersections and 144
# blocks instead of 45 and 76. But the sensor network is concentrated on the
# MAJORS, so coverage drops sharply. Run `python grid.py` after toggling this
# and check edge_coverage_pct: if it falls far, the router is guessing about
# most of the city rather than measuring it.
INCLUDE_LITTLE_STREETS = True

EW_MAJOR = ["Flinders", "Collins", "Bourke", "Lonsdale", "LaTrobe"]
EW_LITTLE = {                       # little street -> the major it sits north of
    "Flinders": "FlindersLane",
    "Collins": "LittleCollins",
    "Bourke": "LittleBourke",
    "Lonsdale": "LittleLonsdale",
}

def _ew_streets() -> list[str]:
    if not INCLUDE_LITTLE_STREETS:
        return list(EW_MAJOR)
    out = []
    for i, major in enumerate(EW_MAJOR):
        out.append(major)
        if major in EW_LITTLE and i < len(EW_MAJOR) - 1:
            out.append(EW_LITTLE[major])
    return out

EW_STREETS = _ew_streets()

# --- Grid geometry -------------------------------------------------------
# The 45 intersections are interpolated bilinearly from the four corners of the
# grid, so there are no spacing or rotation constants to get wrong. Real block
# lengths then vary naturally instead of all reading exactly the same.
#
# REPLACE THESE with clicked values. Drop the collector into the Leaflet map:
#
#     map.on('click', e => console.log(
#       `(${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}),`));
#
# then click the four corner intersections and paste the results below.
CORNERS: dict[tuple[str, str], tuple[float, float]] = {
    ("Spencer", "Flinders"): (-37.82107, 144.95505),
    ("Spring",  "Flinders"): (-37.81526, 144.97488),
    ("Spencer", "LaTrobe"):  (-37.81317, 144.95142),
    ("Spring",  "LaTrobe"):  (-37.80747, 144.97126),
}

# Hand-corrected intersections. Anything in here wins over the generated value.
NODE_OVERRIDES: dict[str, tuple[float, float]] = {
    # "Swanston/Bourke": (-37.81375, 144.96513),
}

COMPASS = {
    "north": 0.0, "north east": 45.0, "northeast": 45.0, "north-east": 45.0,
    "east": 90.0, "south east": 135.0, "southeast": 135.0, "south-east": 135.0,
    "south": 180.0, "south west": 225.0, "southwest": 225.0, "south-west": 225.0,
    "west": 270.0, "north west": 315.0, "northwest": 315.0, "north-west": 315.0,
    "n": 0.0, "ne": 45.0, "e": 90.0, "se": 135.0,
    "s": 180.0, "sw": 225.0, "w": 270.0, "nw": 315.0,
}


@dataclass(frozen=True)
class Sensor:
    location_id: int
    description: str
    lat: float
    lng: float
    bearing_d1: float | None
    bearing_d2: float | None


# --------------------------------------------------------------------------
# Geometry helpers
# --------------------------------------------------------------------------

EARTH_R_M = 6_371_000.0


from dataclasses import dataclass
import os

REFUGES_CSV = "landmarks_poi_noise_cleaned.csv"

@dataclass(frozen=True)
class RefugePOI:
    poi_id: str
    name: str
    sub_theme: str
    lat: float
    lng: float
    noise_level: str

def load_refuges(csv_path: str = REFUGES_CSV) -> dict[str, RefugePOI]:
    if not os.path.exists(csv_path):
        csv_path = os.path.join("data", os.path.basename(csv_path))
    if not os.path.exists(csv_path):
        return {}
    
    df = pd.read_csv(csv_path)
    refuges = {}
    for r in df.itertuples():
        refuges[r.poi_id] = RefugePOI(
            poi_id=str(r.poi_id),
            name=str(r.feature_name),
            sub_theme=str(r.sub_theme),
            lat=float(r.latitude),
            lng=float(r.longitude),
            noise_level=str(r.noise_proxy_level),
        )
    return refuges

REFUGES: dict[str, RefugePOI] = load_refuges()

def find_nearby_refuges(lat: float, lng: float, radius_m: float = 800.0) -> list[dict]:
    results = []
    for r in REFUGES.values():
        dist = haversine_m(lat, lng, r.lat, r.lng)
        if dist <= radius_m:
            results.append({
                "poi_id": r.poi_id,
                "name": r.name,
                "sub_theme": r.sub_theme,
                "lat": r.lat,
                "lng": r.lng,
                "noise_level": r.noise_level,
                "distance_m": round(dist),
                "minutes": round(dist / 80.0),
                "nearest_node": nearest_node(r.lat, r.lng)
            })
    return sorted(results, key=lambda x: x["distance_m"])



def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = radians(lat1), radians(lat2)
    dlat, dlng = radians(lat2 - lat1), radians(lng2 - lng1)
    h = sin(dlat / 2) ** 2 + cos(p1) * cos(p2) * sin(dlng / 2) ** 2
    return 2 * EARTH_R_M * asin(sqrt(h))


def bearing_deg(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Initial compass bearing from point 1 to point 2, 0-360."""
    p1, p2 = radians(lat1), radians(lat2)
    dlng = radians(lng2 - lng1)
    y = sin(dlng) * cos(p2)
    x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dlng)
    return (degrees(atan2(y, x)) + 360.0) % 360.0


def midpoint(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)


def opposes(my_heading: float, flow_bearing: float | None) -> bool:
    """True if a flow at `flow_bearing` comes towards someone heading
    `my_heading`. False when the bearing is unknown, so callers fall back to
    density-only scoring."""
    if flow_bearing is None:
        return False
    diff = abs(my_heading - flow_bearing) % 360.0
    return min(diff, 360.0 - diff) > 90.0


def to_bearing(value) -> float | None:
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    return COMPASS.get(str(value).strip().lower().replace("_", " "))


# --------------------------------------------------------------------------
# Nodes: the street grid
# --------------------------------------------------------------------------

def build_nodes() -> dict[str, tuple[float, float]]:
    """Bilinear interpolation across the four clicked corners of the grid.

    u runs 0 (Spencer) -> 1 (Spring); v runs 0 (Flinders) -> 1 (LaTrobe).
    """
    sw = CORNERS[(NS_STREETS[0],  EW_STREETS[0])]
    se = CORNERS[(NS_STREETS[-1], EW_STREETS[0])]
    nw = CORNERS[(NS_STREETS[0],  EW_STREETS[-1])]
    ne = CORNERS[(NS_STREETS[-1], EW_STREETS[-1])]

    nodes: dict[str, tuple[float, float]] = {}
    for i, ns in enumerate(NS_STREETS):
        u = i / (len(NS_STREETS) - 1)
        for j, ew in enumerate(EW_STREETS):
            v = j / (len(EW_STREETS) - 1)
            lat = ((1 - u) * (1 - v) * sw[0] + u * (1 - v) * se[0]
                   + (1 - u) * v * nw[0] + u * v * ne[0])
            lng = ((1 - u) * (1 - v) * sw[1] + u * (1 - v) * se[1]
                   + (1 - u) * v * nw[1] + u * v * ne[1])
            name = f"{ns}/{ew}"
            nodes[name] = NODE_OVERRIDES.get(name, (round(lat, 6), round(lng, 6)))
    return nodes


def build_graph(nodes: dict[str, tuple[float, float]]) -> nx.Graph:
    """Connect ONLY adjacent intersections on the same street. This is what
    keeps every edge on a real block instead of cutting across the city."""
    g = nx.Graph()
    for name, (lat, lng) in nodes.items():
        g.add_node(name, lat=lat, lng=lng)

    def link(u: str, v: str, street: str) -> None:
        a, b = nodes[u], nodes[v]
        g.add_edge(u, v,
                   length_m=round(haversine_m(a[0], a[1], b[0], b[1]), 1),
                   bearing=round(bearing_deg(a[0], a[1], b[0], b[1]), 1),
                   street=street)

    for ns in NS_STREETS:                       # blocks along north-south streets
        for a, b in zip(EW_STREETS, EW_STREETS[1:]):
            link(f"{ns}/{a}", f"{ns}/{b}", ns)
    for ew in EW_STREETS:                       # blocks along east-west streets
        for a, b in zip(NS_STREETS, NS_STREETS[1:]):
            link(f"{a}/{ew}", f"{b}/{ew}", ew)
    return g


# --------------------------------------------------------------------------
# Sensors, and mapping them onto blocks
# --------------------------------------------------------------------------

def load_sensors(csv_path: str = SENSORS_CSV) -> dict[int, Sensor]:
    df = pd.read_csv(csv_path)

    if "location_id" not in df.columns and "sensor_id" in df.columns:
        df = df.rename(columns={"sensor_id": "location_id"})

    if "latitude" not in df.columns and "location" in df.columns:
        df[["latitude", "longitude"]] = (
            df["location"].astype(str).str.strip("()")
            .str.split(",", expand=True).astype(float)
        )

    df["latitude"] = df["latitude"].astype(float)
    df["longitude"] = df["longitude"].astype(float)

    # Catches the reversed lat/lng bug before it poisons everything downstream.
    assert df.latitude.between(-38.5, -37.4).all(), "latitude outside Victoria"
    assert df.longitude.between(144.5, 145.5).all(), "longitude outside Victoria"

    if "status" in df.columns:
        df = df[df.status.astype(str).str.upper().str.startswith("A")]

    desc_col = "sensor_description" if "sensor_description" in df.columns else "sensor_name"

    out: dict[int, Sensor] = {}
    for r in df.itertuples():
        b1 = to_bearing(getattr(r, "direction_1", None))
        b2 = to_bearing(getattr(r, "direction_2", None))
        # Sensors count bi-directionally along one axis, so a missing side is
        # the opposite of the one that is present. Inference, not a guess.
        if b1 is None and b2 is not None:
            b1 = (b2 + 180.0) % 360.0
        if b2 is None and b1 is not None:
            b2 = (b1 + 180.0) % 360.0
        out[int(r.location_id)] = Sensor(
            location_id=int(r.location_id),
            description=str(getattr(r, desc_col, "")),
            lat=float(r.latitude), lng=float(r.longitude),
            bearing_d1=b1, bearing_d2=b2,
        )
    return out


def map_edges_to_sensors(g: nx.Graph, nodes, sensors,
                         radius_m: float = SENSOR_RADIUS_M) -> dict[frozenset, list[int]]:
    """ALL sensors within `radius_m` of each block's midpoint, nearest first.

    Not just the closest one. Two sensors can sit on the same corner and read
    very differently - Flinders/Elizabeth has one at 16 m reading 5/min and
    another at 105 m reading 86/min. Taking only the nearest would score that
    block as quiet. The scoring engine decides what to do with the list; this
    function only reports what is in range.

    An empty list means UNMEASURED, which must never be read as quiet.
    """
    mapping: dict[frozenset, list[int]] = {}
    for u, v in g.edges:
        mid = midpoint(nodes[u], nodes[v])
        near = []
        for sid, s in sensors.items():
            d = haversine_m(mid[0], mid[1], s.lat, s.lng)
            if d <= radius_m:
                near.append((d, sid))
        near.sort()
        mapping[frozenset((u, v))] = [sid for _, sid in near]
    return mapping


# --------------------------------------------------------------------------
# Module-level: built ONCE at import, never inside a request handler.
# --------------------------------------------------------------------------

NODES: dict[str, tuple[float, float]] = build_nodes()
GRAPH: nx.Graph = build_graph(NODES)

try:
    SENSORS: dict[int, Sensor] = load_sensors()
except FileNotFoundError:
    import os
    print(f"WARNING: no sensor file at {os.path.abspath(SENSORS_CSV)}\n"
          f"         Every block will read UNMEASURED until it exists.\n"
          f"         Working directory is {os.getcwd()}")
    SENSORS = {}

EDGE_SENSORS: dict[frozenset, list[int]] = map_edges_to_sensors(GRAPH, NODES, SENSORS)


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def nearest_node(lat: float, lng: float) -> str:
    """Snap an arbitrary map position to the closest intersection."""
    return min(NODES, key=lambda n: haversine_m(lat, lng, NODES[n][0], NODES[n][1]))


def project_to_edge(lat: float, lng: float) -> dict | None:
    """Project a position onto the nearest BLOCK, not the nearest corner.

    Snapping to a node discards up to ~116 m (half a block) and starts the walk
    somewhere the person is not. Projecting onto the edge finds the point on the
    street they are actually standing beside, then reports how far it is to each
    end of that block, so the router can choose which end to enter by.

    Returns:
        u, v          the block they are standing on
        point         (lat, lng) of the projected position on that block
        offset_m      perpendicular walk from where they are to the street
        to_u_m/to_v_m walk along the block from the projection to each corner
    """
    if not NODES:
        return None

    # Equirectangular projection, local to Melbourne. Accurate to well under a
    # metre at CBD scale and far cheaper than doing this on the sphere.
    lat0 = radians(lat)
    kx = cos(lat0) * 111_320.0
    ky = 111_320.0
    to_xy = lambda a, b: ((b - lng) * kx, (a - lat) * ky)

    best = None
    for u, v in GRAPH.edges:
        ax, ay = to_xy(*NODES[u])
        bx, by = to_xy(*NODES[v])
        dx, dy = bx - ax, by - ay
        seg2 = dx * dx + dy * dy
        if seg2 == 0:
            continue
        # t is how far along the block the projection falls, clamped to its ends
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / seg2))
        px, py = ax + t * dx, ay + t * dy
        d = sqrt(px * px + py * py)
        if best is None or d < best[0]:
            best = (d, u, v, t)

    d, u, v, t = best
    length = edge_length(u, v)
    au, av = NODES[u], NODES[v]
    return {
        "u": u, "v": v,
        "point": (round(au[0] + t * (av[0] - au[0]), 6),
                  round(au[1] + t * (av[1] - au[1]), 6)),
        "offset_m": round(d, 1),
        "to_u_m": round(t * length, 1),
        "to_v_m": round((1.0 - t) * length, 1),
    }


def snap(lat: float, lng: float) -> tuple[str, float]:
    """(intersection, metres away). The distance matters: blocks are ~232 m, so
    a snap can move someone over 100 m. The client must show that rather than
    silently relocating them."""
    node = nearest_node(lat, lng)
    return node, round(haversine_m(lat, lng, NODES[node][0], NODES[node][1]), 1)


def edge_length(u: str, v: str) -> float:
    return GRAPH[u][v]["length_m"]


def edge_street(u: str, v: str) -> str:
    return GRAPH[u][v]["street"]


def edge_bearing(u: str, v: str) -> float:
    """Compass heading walking FROM u TO v. The stored bearing is for one
    canonical orientation, so flip it when travelling the other way."""
    a, b = NODES[u], NODES[v]
    return bearing_deg(a[0], a[1], b[0], b[1])


def sensors_for_edge(u: str, v: str) -> list[int]:
    """Every sensor within range of this block, nearest first. Empty = unmeasured."""
    return EDGE_SENSORS.get(frozenset((u, v)), [])


def sensor_for_edge(u: str, v: str) -> int | None:
    """The CLOSEST sensor, for labelling and debugging only.

    Do not use this for scoring: the nearest sensor is not necessarily the one
    that matters. Use sensors_for_edge() and pick the worst reading.
    """
    near = sensors_for_edge(u, v)
    return near[0] if near else None


def coords(path: list[str]) -> list[tuple[float, float]]:
    """Intersection names -> [lat, lng] pairs, ready for L.polyline()."""
    return [NODES[n] for n in path]


# --------------------------------------------------------------------------
# Diagnostics — run before trusting anything built on top
# --------------------------------------------------------------------------

LITTLE_NAMES = set(EW_LITTLE.values())


def coverage_by_street_type() -> dict:
    """Sensor coverage split between major streets and the little ones.

    The sensor network is concentrated on the majors, so a headline coverage
    figure hides the real picture: adding the little streets can leave the
    router measuring the busy roads well and guessing about everything else.
    """
    out = {"major": [0, 0], "little": [0, 0]}
    for u, v, d in GRAPH.edges(data=True):
        kind = "little" if d["street"] in LITTLE_NAMES else "major"
        out[kind][1] += 1
        if EDGE_SENSORS.get(frozenset((u, v))):
            out[kind][0] += 1
    return {k: {"measured": a, "blocks": b,
                "pct": round(100 * a / b, 1) if b else 0.0}
            for k, (a, b) in out.items()}


def sensor_mismatches() -> list[str]:
    """Blocks whose matched sensor description doesn't mention the street the
    block runs along. Some hits are legitimate (sensors named after buildings,
    e.g. 'Collins Place (North)'), but a Collins block matching a sensor named
    '474 Flinders Street' means the radius is too wide or the grid is shifted.
    """
    out: list[str] = []
    for u, v, d in GRAPH.edges(data=True):
        sid = sensor_for_edge(u, v)
        if sid is None:
            continue
        street = (d["street"].lower()
                  .replace("latrobe", "la trobe")
                  .replace("littlecollins", "little collins")
                  .replace("littlebourke", "little bourke")
                  .replace("littlelonsdale", "little lonsdale")
                  .replace("flinderslane", "flinders lane"))
        desc = SENSORS[sid].description.lower()
        if street not in desc:
            out.append(f"{u} -> {v} ({d['street']}) matched '{SENSORS[sid].description}'")
    return out


def diagnostics() -> dict:
    lengths = [d["length_m"] for _, _, d in GRAPH.edges(data=True)]
    covered = sum(1 for s in EDGE_SENSORS.values() if s)
    n_edges = GRAPH.number_of_edges()
    with_bearing = sum(1 for s in SENSORS.values() if s.bearing_d1 is not None)
    mismatches = sensor_mismatches()

    return {
        "nodes": GRAPH.number_of_nodes(),
        "edges": n_edges,
        "connected": nx.is_connected(GRAPH) if GRAPH.number_of_nodes() else False,
        "edge_length_min_m": round(min(lengths), 1) if lengths else None,
        "edge_length_max_m": round(max(lengths), 1) if lengths else None,
        "edge_length_mean_m": round(sum(lengths) / len(lengths), 1) if lengths else None,
        "sensors_loaded": len(SENSORS),
        "sensors_with_bearing": with_bearing,
        "bearing_coverage_pct": round(100 * with_bearing / len(SENSORS), 1) if SENSORS else 0.0,
        "edges_with_sensor": covered,
        "mean_sensors_per_edge": round(
            sum(len(s) for s in EDGE_SENSORS.values()) / n_edges, 2) if n_edges else 0,
        "edge_coverage_pct": round(100 * covered / n_edges, 1) if n_edges else 0.0,
        "sensor_mismatches": len(mismatches),
        "little_streets": INCLUDE_LITTLE_STREETS,
        "coverage_by_type": coverage_by_street_type(),
    }


if __name__ == "__main__":
    import json
    print(json.dumps(diagnostics(), indent=2))

    bad = sensor_mismatches()
    if bad:
        print(f"\nMismatched blocks ({len(bad)}) - review these by eye:")
        for line in bad[:20]:
            print("  ", line)
        if len(bad) > 20:
            print(f"   ... and {len(bad) - 20} more")

    a, b = "Spencer/Flinders", "Spring/LaTrobe"
    if GRAPH.has_node(a) and GRAPH.has_node(b) and nx.has_path(GRAPH, a, b):
        p = nx.shortest_path(GRAPH, a, b, weight="length_m")
        total = sum(edge_length(u, v) for u, v in zip(p, p[1:]))
        print(f"\nSample path {a} -> {b}: {len(p)} stops, {total:.0f} m")
        for u, v in zip(p, p[1:]):
            sid = sensor_for_edge(u, v)
            tag = SENSORS[sid].description if sid else "UNMEASURED"
            print(f"  {u:>22} -> {v:<22} {edge_bearing(u,v):5.0f}deg  {tag}") 


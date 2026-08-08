"""
Routing engine (routing.py) — Person B.

Turns a scored graph into two comparable routes: the calmest path and the
shortest one. Contains NO scoring logic. If you find a threshold or a weight in
this file, it belongs in scoring.py.

The graph is DIRECTED. Every block is added twice, once per direction of
travel, because walking Bourke Street eastbound and westbound cost different
amounts once counterflow is in play.

Public surface used by main.py:
    plan(origin, destination, tolerance, loads) -> dict
    node_list() -> list[dict]
"""

from __future__ import annotations

import networkx as nx

import grid
import scoring

# Average walking pace, metres per minute. Used only for the time estimate
# shown to the user; it plays no part in route selection.
WALK_M_PER_MIN = 80.0

# In the lowest-peak search, an unmeasured block is this many times more
# expensive than a measured one of the same length. It does not change which
# ceiling is achievable - only which of the tied paths is returned - so it
# steers the result toward blocks we can actually vouch for.
UNVERIFIED_TIEBREAK = 2.5


# --------------------------------------------------------------------------
# Graph construction
# --------------------------------------------------------------------------

def scored_graph(tolerance: int, loads) -> nx.DiGraph:
    """Directed copy of the street grid, weighted by sensory cost."""
    g = nx.DiGraph()
    for a, b in grid.GRAPH.edges:
        for u, v in ((a, b), (b, a)):
            g.add_edge(u, v,
                       sensory=scoring.edge_cost(u, v, tolerance, loads),
                       length=grid.edge_length(u, v))
    return g


def lowest_peak_path(origin: str, destination: str, loads) -> list[str] | None:
    """Bottleneck shortest path: minimise the WORST block, not the total.

    plan() otherwise minimises the SUM of block costs, but a route is RATED by
    its peak. Those are different objectives, and they disagree: a path can win
    on total by threading through many cheap unmeasured blocks while still
    crossing one busy corridor. For a sensory-sensitive walker the worst block
    is the one that ruins the trip, so this offers the path that minimises it.

    Binary search over the observed densities: for a candidate ceiling, keep
    only blocks at or below it and ask whether a path still exists.
    """
    assumed = scoring.assumed_density(loads)
    levels = sorted({d for d in (scoring.block_density(u, v, loads)
                                 for u, v in grid.GRAPH.edges) if d is not None}
                    | {assumed})
    if not levels:
        return None

    best = None
    lo, hi = 0, len(levels) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        ceiling = levels[mid]
        h2 = nx.Graph()
        for u, v in grid.GRAPH.edges:
            d = scoring.block_density(u, v, loads)
            # An unmeasured block counts as the assumed density, the same
            # figure the cost function uses. Treating "unknown" as "passable at
            # any ceiling" would let this route escape into pure ignorance and
            # come back 0% measured, which is not a calmer route - it is an
            # unverified one.
            unknown = d is None
            if unknown:
                d = assumed
            if d <= ceiling:
                # Among paths that tie on the ceiling, prefer VERIFIED blocks.
                # Without this the search returns whichever path is shortest,
                # which tends to be a chain of unmeasured blocks - a route we
                # cannot vouch for, reported as 0% measured.
                w = grid.edge_length(u, v) * (UNVERIFIED_TIEBREAK if unknown else 1.0)
                h2.add_edge(u, v, cost=w)
        if h2.has_node(origin) and h2.has_node(destination) \
                and nx.has_path(h2, origin, destination):
            best = nx.shortest_path(h2, origin, destination, weight="cost")
            hi = mid - 1
        else:
            lo = mid + 1
    return best


# --------------------------------------------------------------------------
# Summarising a path
# --------------------------------------------------------------------------

def _summarise(path: list[str], route_id: str, tolerance: int, loads) -> dict:
    blocks = list(zip(path, path[1:]))
    densities = [scoring.block_density(u, v, loads) for u, v in blocks]
    measured = [d for d in densities if d is not None]

    total_m = sum(grid.edge_length(u, v) for u, v in blocks)
    peak = max(measured) if measured else None

    # A route's rating is driven by its WORST block, not its average. One bad
    # corridor is what ruins a trip for a sensory-sensitive walker.
    rating = scoring.rate(peak)

    return {
        "id": route_id,
        "path": path,
        "coords": [list(c) for c in grid.coords(path)],
        "blocks": len(blocks),
        "distance_m": round(total_m),
        "minutes": round(total_m / WALK_M_PER_MIN),
        "rating": rating,
        "peak_density": peak,
        "mean_density": round(sum(measured) / len(measured)) if measured else None,
        "coverage_pct": round(100 * len(measured) / len(blocks)) if blocks else 0,
        "steps": [
            {
                "from": u, "to": v,
                "street": grid.edge_street(u, v),
                "length_m": grid.edge_length(u, v),
                "density": d,
                "rating": scoring.rate(d),
                "measured": d is not None,
            }
            for (u, v), d in zip(blocks, densities)
        ],
    }


# --------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------

def _entry_options(spec, tolerance: int, loads) -> list[tuple[str, float, dict | None]]:
    """Ways to join the street network from a start/end spec.

    A named intersection has exactly one, costing nothing. A projected position
    has two - either end of the block the person is standing on - and the router
    picks whichever gives the better trip overall, rather than assuming the
    nearer corner is the right one.

    Returns (node, walk_metres, access_leg_or_None).
    """
    if isinstance(spec, str):
        return [(spec, 0.0, None)]

    out = []
    for end, along in (("u", "to_u_m"), ("v", "to_v_m")):
        node = spec[end]
        walk = spec["offset_m"] + spec[along]
        out.append((node, walk, {
            "to_node": node,
            "metres": round(walk, 1),
            "minutes": round(walk / WALK_M_PER_MIN),
            "offset_m": spec["offset_m"],
            "along_block_m": spec[along],
            "on_block": f"{spec['u']} -> {spec['v']}",
            "point": list(spec["point"]),
        }))
    return out


def _access_cost(metres: float, tolerance: int, loads) -> float:
    """Price the walk-in on the same scale as a block, using the assumed
    density, so it competes fairly against the routed portion."""
    if metres <= 0:
        return 0.0
    assumed = min(scoring.assumed_density(loads), scoring.DENSITY_CEILING)
    return metres * (1.0 + scoring.W_DENSITY * assumed / max(tolerance, 1))


def plan(origin, destination, tolerance: int, loads,
         source: str = "unknown") -> dict:
    """Two routes between two intersections: calmest and shortest.

    Raises ValueError for unknown intersection names, which main.py turns into
    a 400 rather than a 500.
    """
    for spec, label in ((origin, "origin"), (destination, "destination")):
        if isinstance(spec, str) and spec not in grid.NODES:
            raise ValueError(f"unknown intersection: {spec}")

    o_opts = _entry_options(origin, tolerance, loads)
    d_opts = _entry_options(destination, tolerance, loads)

    g = scored_graph(tolerance, loads)

    # Try every combination of entry and exit corner, and keep the cheapest
    # overall. This is why projecting beats snapping: the nearer corner is not
    # always the one that gives the better walk.
    best = None
    for o_node, o_walk, o_leg in o_opts:
        for d_node, d_walk, d_leg in d_opts:
            if o_node == d_node:
                continue
            try:
                p = nx.shortest_path(g, o_node, d_node, weight="sensory")
            except nx.NetworkXNoPath:
                continue
            total = (sum(g[a][b]["sensory"] for a, b in zip(p, p[1:]))
                     + _access_cost(o_walk, tolerance, loads)
                     + _access_cost(d_walk, tolerance, loads))
            if best is None or total < best[0]:
                best = (total, o_node, d_node, o_leg, d_leg, o_walk, d_walk)

    if best is None:
        raise ValueError("no route between those points")
    _, origin, destination, o_leg, d_leg, o_walk, d_walk = best

    if origin == destination:
        raise ValueError("origin and destination are the same")

    calm_path = nx.shortest_path(g, origin, destination, weight="sensory")
    fast_path = nx.shortest_path(g, origin, destination, weight="length")

    quiet_path = lowest_peak_path(origin, destination, loads)

    calm = _summarise(calm_path, "calm", tolerance, loads)
    routes = [calm]
    seen = [calm_path]

    # Lowest-peak route: what the RATING actually measures. Often different
    # from the lowest-total route, and usually the one a sensory-sensitive
    # walker would pick.
    if quiet_path and quiet_path not in seen:
        routes.append(_summarise(quiet_path, "quiet", tolerance, loads))
        seen.append(quiet_path)

    # Only offer the fast route when it is genuinely a different option.
    if fast_path not in seen:
        routes.append(_summarise(fast_path, "fast", tolerance, loads))

    # Confidence is computed, not decorative: it degrades when much of the
    # route is unmeasured or when the crowd data is a cached fallback.
    cov = calm["coverage_pct"]
    if source == "cached" or cov < 40:
        confidence = "low"
    elif cov < 70:
        confidence = "medium"
    else:
        confidence = "high"

    access_m = o_walk + d_walk
    for r in routes:
        r["access_m"] = round(access_m)
        r["total_m"] = round(r["distance_m"] + access_m)
        r["total_minutes"] = round(r["total_m"] / WALK_M_PER_MIN)

    return {
        "data": {"routes": routes,
                 "access": {"start": o_leg, "end": d_leg}},
        "meta": {
            "source": source,
            "confidence": confidence,
            "basis": f"{cov}% of the calm route has live sensor coverage",
            "coverage_pct": cov,
            "tolerance": tolerance,
            "attribution": "City of Melbourne, CC BY 4.0",
        },
    }


def node_list() -> list[dict]:
    """Every intersection, for the origin/destination pickers in the client."""
    return [{"id": n, "lat": ll[0], "lng": ll[1]} for n, ll in sorted(grid.NODES.items())]


def blocks(loads) -> dict:
    """Every block the router knows about, with its current reading.

    A debug view: it answers "does the network actually contain the street I am
    standing on, and what does it think is happening there?" without having to
    plan a route to find out.
    """
    out = []
    for u, v, d in grid.GRAPH.edges(data=True):
        density = scoring.block_density(u, v, loads)
        sids = grid.sensors_for_edge(u, v)
        out.append({
            "from": u, "to": v,
            "street": d["street"],
            "little": d["street"] in grid.LITTLE_NAMES,
            "coords": [list(grid.NODES[u]), list(grid.NODES[v])],
            "length_m": d["length_m"],
            "density": density,
            "rating": scoring.rate(density),
            "sensors": sids,
            "sensor_names": [grid.SENSORS[s].description for s in sids],
        })
    return {
        "data": {"blocks": out},
        "meta": {
            "blocks": len(out),
            "measured": sum(1 for b in out if b["density"] is not None),
            "little_streets": grid.INCLUDE_LITTLE_STREETS,
            "match_radius_m": grid.SENSOR_RADIUS_M,
        },
    }


def heatmap(loads) -> dict:
    """Current density at every reporting sensor, normalised for the client.

    Sensors that did not report are omitted entirely rather than sent as zero,
    so the client can render a gap as a gap.
    """
    points = []
    for sid, s in grid.SENSORS.items():
        load = loads.get(sid)
        if load is None:
            continue
        points.append({
            "id": sid,
            "lat": s.lat, "lng": s.lng,
            "density": load.total,
            "d1": load.d1,
            "d2": load.d2,
            "intensity": scoring.normalise(load.total),
            "rating": scoring.rate(load.total),
            "name": s.description,
        })
    return {
        "data": {"points": points},
        "meta": {
            "reporting": len(points),
            "sensors": len(grid.SENSORS),
            "attribution": "City of Melbourne, CC BY 4.0",
        },
    }

def find_refuges(lat: float | None = None, lng: float | None = None, 
                 node: str | None = None, radius_m: float = 800.0) -> dict:
    if node and node in grid.NODES:
        lat, lng = grid.NODES[node]
    elif lat is None or lng is None:
        lat, lng = -37.8136, 144.9631  # CBD default center

    refuges = grid.find_nearby_refuges(lat, lng, radius_m=radius_m)
    return {
        "data": {"refuges": refuges},
        "meta": {"count": len(refuges), "radius_m": radius_m}
    }
# --------------------------------------------------------------------------
# Self-test
# --------------------------------------------------------------------------

if __name__ == "__main__":
    import json
    import crowd

    loads = crowd.stub_loads(grid.SENSORS)
    result = plan("Spencer/Flinders", "Spring/LaTrobe", tolerance=80,
                  loads=loads, source=crowd.source())

    for r in result["data"]["routes"]:
        print(f"{r['id']:>5}: {r['blocks']} blocks, {r['distance_m']} m, "
              f"{r['minutes']} min, rating {r['rating']}, "
              f"peak {r['peak_density']}, coverage {r['coverage_pct']}%")

    print(f"\nmeta: {result['meta']['confidence']} confidence "
          f"— {result['meta']['basis']}")

    print("\nfirst four steps of the calm route:")
    for s in result["data"]["routes"][0]["steps"][:4]:
        tag = f"{s['density']}/min" if s["measured"] else "unmeasured"
        print(f"   {s['street']:<12} {s['from']:>22} -> {s['to']:<22} "
              f"{s['rating']:>7}  {tag}")

    hm = heatmap(loads)
    print(f"\nheatmap: {hm['meta']['reporting']} of {hm['meta']['sensors']} "
          f"sensors reporting")
    print(f"nodes available to the client: {len(node_list())}")

    print("\nerror handling:")
    for bad in ("Nowhere/Street", "Spencer/Flinders"):
        try:
            plan("Spencer/Flinders", bad, 80, loads)
            print(f"   {bad}: no error raised")
        except ValueError as e:
            print(f"   {bad}: ValueError — {e}")
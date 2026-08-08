"""
Scoring engine (scoring.py) — Person B.

The only opinionated file in the project. grid.py states facts about geometry,
crowd.py states facts about counts; this file makes judgements about what those
facts cost a sensory-sensitive walker.

    cost = length_m x (1 + w_density x density + w_opposing x opposing)

Length is the base, so a route cannot win by being calm but absurdly long. The
multiplier is how much worse crowding makes the same distance feel.

Owns three decisions that must exist in exactly ONE place, or the map and the
route card will contradict each other:
    1. density -> rating thresholds        (rate)
    2. heatmap intensity normalisation     (normalise)
    3. what an unmeasured block costs      (assumed_density)

Public surface used by routing.py / main.py:
    edge_cost(u, v, tolerance, loads)
    block_density(u, v, loads)
    rate(density)
    normalise(density)
    explain(u, v, tolerance, loads)
"""

from __future__ import annotations

from typing import Literal

import grid

# --------------------------------------------------------------------------
# Tunable constants. Everything the demo needs to feel right is in this block.
# --------------------------------------------------------------------------

# Crowd density bands, people per minute. From the Data Management Plan.
THRESHOLDS = {"low": 50, "medium": 150}

# How much each factor inflates the walk. Raise W_DENSITY to make the calm
# route detour more aggressively around crowds.
W_DENSITY = 1.2
W_OPPOSING = 0.8

# A block with no sensor in range is UNMEASURED. It is not quiet, and it must
# not be cheap, or the router learns to prefer ignorance and threads every route
# through its own blind spots.
#
# But a FIXED guess is fragile. 150/min was reasonable while we assumed CBD
# density ran 50-150; it was badly wrong once live readings turned out to run
# 1-102, because it priced every gap as worse than the busiest street in the
# city. So the assumption is DERIVED from what the city is actually doing right
# now: the median across reporting sensors. Unknown is then priced as "a typical
# block", never as "the worst block".
UNMEASURED_FALLBACK_DENSITY = 30    # used only when nothing is reporting
UNMEASURED_EXTRA = 0.3              # penalty for the uncertainty itself

_assumed_cache: dict = {}


def assumed_density(loads) -> float:
    """Median density across reporting sensors: what an unmeasured block is
    assumed to be. Memoised per loads object, since it is called once per edge
    and the answer is identical across a single routing pass."""
    key = id(loads)
    if key not in _assumed_cache:
        _assumed_cache.clear()      # only one live loads dict at a time
        totals = sorted(l.total for l in loads.values())
        _assumed_cache[key] = (float(totals[len(totals) // 2]) if totals
                               else float(UNMEASURED_FALLBACK_DENSITY))
    return _assumed_cache[key]

# Density is normalised against the user's own tolerance. A ceiling stops one
# extreme block dominating a long route - but it must be an ABSOLUTE ceiling on
# density, not a cap on the density/tolerance ratio.
#
# Capping the ratio was a bug: at tolerance 20 a ratio cap of 4.0 saturates at
# 80 people/min, so an 88/min block and a 102/min block scored identically and
# the router could not tell them apart. The most sensitive user got the least
# discriminating routes, which is exactly backwards.
DENSITY_CEILING = 250.0   # people/min; above this, extra crowding stops mattering

# Opposing flow is normalised against this reference volume, in people per
# minute walking towards you. Above it, the term saturates.
OPPOSING_REF = 100.0

# Heatmap intensity of 1.0 corresponds to this density.
HEATMAP_CEILING = 250.0

Rating = Literal["low", "medium", "high", "unknown"]


# --------------------------------------------------------------------------
# Reading the crowd
# --------------------------------------------------------------------------

def busiest_sensor(u: str, v: str, loads):
    """(sensor_id, load) for the WORST reading on this block, or None.

    A block can have several sensors in range, and the nearest is not
    necessarily the one that matters. Flinders/Elizabeth has a sensor at 16 m
    reading 5/min and another at 105 m reading 86/min; scoring that block as
    quiet because the quiet sensor happens to be closer is exactly the failure
    this avoids. For a sensory-sensitive walker the worst reading on the block
    is the one they will experience.
    """
    best = None
    for sid in grid.sensors_for_edge(u, v):
        load = loads.get(sid)      # .get: a sensor can legitimately not report
        if load is None:
            continue
        if best is None or load.total > best[1].total:
            best = (sid, load)
    return best


def block_density(u: str, v: str, loads) -> int | None:
    """People per minute on this block, or None if it is unmeasured.

    None means no sensor in range reported. It never means zero.
    """
    best = busiest_sensor(u, v, loads)
    return None if best is None else best[1].total


def opposing_volume(u: str, v: str, loads) -> int | None:
    """People per minute walking TOWARDS someone going from u to v.

    The bearing comes from grid.SENSORS, not from the load: which way a sensor
    faces is static metadata that never changes minute to minute, so crowd.py
    only has to supply counts.

    Returns None when the block is unmeasured, when the sensor did not report,
    or when the sensor has no usable direction metadata (about 25% of ours).
    Callers fall back to density-only scoring in that case.
    """
    best = busiest_sensor(u, v, loads)
    if best is None:
        return None
    sid, load = best
    bearing = grid.SENSORS[sid].bearing_d1
    if bearing is None:
        return None
    heading = grid.edge_bearing(u, v)
    return load.d1 if grid.opposes(heading, bearing) else load.d2


# --------------------------------------------------------------------------
# The cost function — this is the project
# --------------------------------------------------------------------------

def edge_cost(u: str, v: str, tolerance: int, loads) -> float:
    """Routing weight for walking from u to v.

    Directional: walking a block northbound and southbound can cost different
    amounts, because the crowd coming at you differs.
    """
    length = grid.edge_length(u, v)
    tol = max(tolerance, 1)

    density = block_density(u, v, loads)
    if density is None:
        # Unknown is not quiet. Price it as a moderate crowd, scaled by the
        # same tolerance, plus a penalty for the uncertainty itself.
        assumed = min(assumed_density(loads), DENSITY_CEILING) / tol
        return length * (1.0 + W_DENSITY * assumed + UNMEASURED_EXTRA)

    density_norm = min(density, DENSITY_CEILING) / tol
    multiplier = 1.0 + W_DENSITY * density_norm

    opposing = opposing_volume(u, v, loads)
    if opposing is not None:
        multiplier += W_OPPOSING * min(opposing / OPPOSING_REF, 1.0)

    return length * multiplier


# --------------------------------------------------------------------------
# Interpretation — the single source of truth for labels and colours
# --------------------------------------------------------------------------

def rate(density: int | None) -> Rating:
    """Density band. 'unknown' is a real answer, not a failure."""
    if density is None:
        return "unknown"
    if density < THRESHOLDS["low"]:
        return "low"
    if density < THRESHOLDS["medium"]:
        return "medium"
    return "high"


def normalise(density: int | None) -> float | None:
    """0-1 heatmap intensity, on the same scale as rate() so the map and the
    route cards never disagree. None stays None so the client can render a gap
    as a gap."""
    if density is None:
        return None
    return round(min(density / HEATMAP_CEILING, 1.0), 3)


def explain(u: str, v: str, tolerance: int, loads) -> dict:
    """Why this block scored what it did. Feeds the confidence metadata in the
    API envelope, and is the fastest way to debug a route that looks wrong."""
    best = busiest_sensor(u, v, loads)
    sid = best[0] if best else None
    density = block_density(u, v, loads)
    opposing = opposing_volume(u, v, loads)
    return {
        "block": f"{u} -> {v}",
        "street": grid.edge_street(u, v),
        "length_m": grid.edge_length(u, v),
        "heading_deg": round(grid.edge_bearing(u, v)),
        "sensor": grid.SENSORS[sid].description if sid else None,
        "sensor_id": sid,
        "sensors_in_range": len(grid.sensors_for_edge(u, v)),
        "density": density,
        "rating": rate(density),
        "opposing": opposing,
        "measured": density is not None,
        "directional": opposing is not None,
        "cost": round(edge_cost(u, v, tolerance, loads), 1),
    }


# --------------------------------------------------------------------------
# Self-test: two tolerances must produce two different routes
# --------------------------------------------------------------------------

if __name__ == "__main__":
    import networkx as nx
    import crowd

    loads = crowd.stub_loads(grid.SENSORS)
    print(f"loads: {len(loads)} of {len(grid.SENSORS)} sensors reporting "
          f"(source: {crowd.source()})\n")

    def scored(tolerance: int) -> nx.DiGraph:
        """Directed: each block is added twice, once per direction of travel."""
        g = nx.DiGraph()
        for a, b in grid.GRAPH.edges:
            g.add_edge(a, b, sensory=edge_cost(a, b, tolerance, loads),
                       length=grid.edge_length(a, b))
            g.add_edge(b, a, sensory=edge_cost(b, a, tolerance, loads),
                       length=grid.edge_length(b, a))
        return g

    PAIRS = [
        ("Spencer/Flinders", "Spring/LaTrobe"),
        ("Swanston/Flinders", "Elizabeth/LaTrobe"),
        ("King/Collins", "Russell/Bourke"),
        ("Elizabeth/Bourke", "Spring/Collins"),
        ("Queen/LaTrobe", "Exhibition/Flinders"),
        ("William/Lonsdale", "Russell/Collins"),
    ]

    measured = sum(1 for a, b in grid.GRAPH.edges
                   if block_density(a, b, loads) is not None)
    print(f"blocks with a reading: {measured} of {grid.GRAPH.number_of_edges()}\n")

    g_tol, g_sen = scored(200), scored(40)
    g_fast = g_tol                       # length weight is tolerance-independent

    def summarise(g, o, d, weight):
        p = nx.shortest_path(g, o, d, weight=weight)
        m = sum(grid.edge_length(a, b) for a, b in zip(p, p[1:]))
        peaks = [block_density(a, b, loads) for a, b in zip(p, p[1:])]
        return p, m, max((x for x in peaks if x is not None), default=None)

    print(f"{'route':<44}{'fast':>12}{'calm':>14}{'peak':>8}  tolerance")
    diff_fast = diff_tol = 0
    for o, d in PAIRS:
        fast, fast_m, fast_peak = summarise(g_fast, o, d, "length")
        calm, calm_m, calm_peak = summarise(g_tol,  o, d, "sensory")
        sens, _, _              = summarise(g_sen,  o, d, "sensory")
        if calm != fast:
            diff_fast += 1
        if calm != sens:
            diff_tol += 1
        name = f"{o.split('/')[0]}/{o.split('/')[1][:4]} to {d.split('/')[0]}/{d.split('/')[1][:4]}"
        print(f"{name:<44}{fast_m:>9.0f} m{calm_m:>11.0f} m"
              f"{str(calm_peak):>8}  {'changes route' if calm != sens else 'same route'}")

    print(f"\ncalm differs from fast: {diff_fast} of {len(PAIRS)} pairs")
    print(f"tolerance changes the route: {diff_tol} of {len(PAIRS)} pairs")
    print("   note: in a regular grid many paths share the same length, so a\n"
          "   change in tolerance often re-ranks costs without flipping the winner.\n"
          "   The claim that matters is calm != fast.\n")

    ORIGIN, DEST = PAIRS[0]

    print("Sample block breakdown:")
    g = scored(80)
    p = nx.shortest_path(g, ORIGIN, DEST, weight="sensory")
    for a, b in list(zip(p, p[1:]))[:5]:
        e = explain(a, b, 80, loads)
        print(f"   {e['block']:<44} {e['rating']:>7}  "
              f"cost {e['cost']:>6}  {'directional' if e['directional'] else 'density only'}")
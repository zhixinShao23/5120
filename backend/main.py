"""
API layer (main.py) — Person B.

Thin. Every endpoint validates its input, calls one function from routing.py,
and returns the result. No routing logic, no scoring logic, no thresholds.

Run it:
    uvicorn main:app --reload --port 8000

Interactive docs, auto-generated from the Pydantic models:
    http://localhost:8000/docs
"""

from __future__ import annotations

import time

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import crowd
import grid
import routing

app = FastAPI(
    title="Hush API",
    description="Sensory-aware wayfinding for Melbourne's CBD.",
    version="0.1.0",
)

# Explicit origins, not "*" — the mock UI is served from a local static server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5500", "http://127.0.0.1:5500",
        "http://localhost:5173", "http://127.0.0.1:5173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------
# Crowd data cache
#
# crowd.get_all_loads() makes ~5 API calls to the council. The feed only
# refreshes every 15 minutes, so hitting it on every request would be slow and
# rude. One fetch serves every user for the cache window.
# --------------------------------------------------------------------------

CACHE_SECONDS = 120

_cache: dict = {"loads": None, "source": "unknown", "at": 0.0}


def current_loads() -> tuple[dict, str, int]:
    """(loads, source, age_seconds). Refreshes only when the cache is stale."""
    age = time.time() - _cache["at"]
    if _cache["loads"] is None or age > CACHE_SECONDS:
        _cache["loads"] = crowd.get_all_loads()
        _cache["source"] = crowd.source()
        _cache["at"] = time.time()
        age = 0.0
    return _cache["loads"], _cache["source"], int(age)


# --------------------------------------------------------------------------
# Models — these generate the OpenAPI schema at /docs
# --------------------------------------------------------------------------

class Point(BaseModel):
    """Either a named intersection or a map position. Coordinates are snapped
    to the nearest intersection, and the response reports how far that moved."""
    node: str | None = Field(None, examples=["King/Flinders"])
    lat: float | None = Field(None, ge=-38.5, le=-37.4)
    lng: float | None = Field(None, ge=144.5, le=145.5)


class RouteRequest(BaseModel):
    origin: Point
    destination: Point
    tolerance: int = Field(
        80, ge=1, le=500,
        description="Crowd tolerance in people per minute. Lower means more "
                    "sensitive, so the router works harder to avoid density.",
    )


def resolve(p: Point, label: str):
    """A named intersection, or a projection onto the block the person is
    standing beside. Projecting rather than snapping keeps the walk-in as a
    real leg of the trip instead of silently discarding up to half a block."""
    if p.node:
        if p.node not in grid.NODES:
            raise HTTPException(400, f"unknown intersection: {p.node}")
        return p.node
    if p.lat is None or p.lng is None:
        raise HTTPException(400, f"{label} needs either a node or lat and lng")
    proj = grid.project_to_edge(p.lat, p.lng)
    if proj is None:
        raise HTTPException(400, f"{label} is outside the mapped area")
    proj["tapped"] = [p.lat, p.lng]
    return proj


# --------------------------------------------------------------------------
# Endpoints
# --------------------------------------------------------------------------

@app.get("/v1/nodes", summary="Every intersection, for the pickers")
def nodes():
    return {"data": {"nodes": routing.node_list()},
            "meta": {"count": len(grid.NODES)}}


@app.post("/v1/route", summary="Calm and fast routes between two intersections")
def route(req: RouteRequest):
    loads, source, age = current_loads()
    origin = resolve(req.origin, "origin")
    destination = resolve(req.destination, "destination")
    try:
        result = routing.plan(origin, destination, req.tolerance,
                              loads, source=source)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    result["meta"]["data_age_seconds"] = age
    for end, spec in (("start", origin), ("end", destination)):
        leg = result["data"]["access"].get(end)
        if leg and isinstance(spec, dict):
            leg["tapped"] = spec["tapped"]
    return result


@app.get("/v1/heatmap", summary="Current density at every reporting sensor")
def heatmap():
    loads, source, age = current_loads()
    result = routing.heatmap(loads)
    result["meta"]["source"] = source
    result["meta"]["data_age_seconds"] = age
    return result


@app.get("/v1/blocks", summary="Every block the router knows, with its reading")
def blocks():
    loads, source, age = current_loads()
    result = routing.blocks(loads)
    result["meta"]["source"] = source
    result["meta"]["data_age_seconds"] = age
    return result


@app.get("/v1/health", summary="Feed freshness and grid coverage")
def health():
    loads, source, age = current_loads()
    covered = sum(1 for s in grid.EDGE_SENSOR.values() if s is not None)
    return {
        "status": "ok" if loads else "degraded",
        "source": source,
        "data_age_seconds": age,
        "sensors_reporting": len(loads),
        "sensors_known": len(grid.SENSORS),
        "blocks": grid.GRAPH.number_of_edges(),
        "blocks_with_sensor": covered,
        "attribution": "City of Melbourne, CC BY 4.0",
    }

@app.get("/v1/refuges", summary="Find nearby sensory refuge locations")
def get_refuges(node: str | None = None, lat: float | None = None, 
                lng: float | None = None, radius_m: float = 800.0):
    return routing.find_refuges(lat=lat, lng=lng, node=node, radius_m=radius_m)
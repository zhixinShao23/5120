"""
Crowd engine (crowd.py) — Person A owns this.

Answers one question: how busy is each sensor right now?

It also hides whether the answer came from the live feed or the cached
snapshot, so nothing downstream ever writes an `if online` check. That
decision happens here and only here.

SCOPE — read this before writing any code:
  This module supplies COUNTS ONLY. It does not deal with sensor positions,
  compass bearings, or anything else static. grid.py already parses the
  direction_1 / direction_2 text columns out of sensors.csv, so Person A does
  not need to touch bearings at all.

  Everything needed here comes from ONE dataset:
      Pedestrian Counting System - Past Hour (counts per minute)
  Not the hourly dataset: that one has no directional split.

THIS FILE CURRENTLY RETURNS FAKE DATA so Person B can build and test the
scoring and routing engines before the real pipeline lands. Person A replaces
the bodies of _from_live() and _from_snapshot(); the dataclass and the two
public function signatures must not change.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

# --------------------------------------------------------------------------
# The contract — agreed between A and B. Do not change without both agreeing.
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class SensorLoad:
    total: int     # people per minute, both directions
    d1: int        # count in direction_1
    d2: int        # count in direction_2


_source = "stub"


def get_all_loads() -> dict[int, SensorLoad]:
    """Current load for every REPORTING sensor, keyed by location_id.

    A sensor may legitimately be ABSENT from this dict: the minute-level feed
    only creates a record when at least one pedestrian passes. Do not pad the
    result with zeros. Callers use .get() and treat a missing sensor as
    unmeasured, which is not the same thing as empty.
    """
    global _source
    try:
        loads = _from_live()
        _source = "live"
        return loads
    except Exception:
        _source = "cached"
        return _from_snapshot()


def source() -> str:
    """'live' | 'cached' | 'stub' — what the last call actually returned."""
    return _source


# --------------------------------------------------------------------------
# Implementations — Person A replaces these two.
# --------------------------------------------------------------------------

def _from_live() -> dict[int, SensorLoad]:
    """Fetch the past-hour counts-per-minute feed, keep the latest reading per
    sensor, and cache the raw frame to data/snapshot.parquet on success."""
    raise NotImplementedError("Person A: fetch the past-hour counts-per-minute feed")


def _from_snapshot() -> dict[int, SensorLoad]:
    """Read data/snapshot.parquet and build the same dict. This is what makes
    the demo survive a bad network."""
    raise NotImplementedError("Person A: read data/snapshot.parquet")


# --------------------------------------------------------------------------
# Temporary stub — delete this block when A's implementation lands.
# --------------------------------------------------------------------------

def stub_loads(sensors, seed: int = 7, missing_rate: float = 0.08) -> dict[int, SensorLoad]:
    """Plausible fake loads keyed to a real sensor dict from grid.SENSORS.

    Deliberately realistic in two ways that catch bugs random numbers hide:
      - d1 + d2 always equals total
      - some sensors are missing entirely, as in the real feed
    """
    rng = random.Random(seed)
    out: dict[int, SensorLoad] = {}
    for sid in sensors:
        if rng.random() < missing_rate:
            continue                                  # sensor didn't report
        total = rng.choice([rng.randint(5, 60),       # quiet
                            rng.randint(60, 160),     # moderate
                            rng.randint(160, 400)])   # busy
        d1 = int(total * rng.uniform(0.25, 0.85))
        out[sid] = SensorLoad(total=total, d1=d1, d2=total - d1)
    return out
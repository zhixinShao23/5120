"""
Crowd engine (crowd.py) — Person A.

Answers one question: how many people are at each sensor right now?

It also hides whether the answer came from the live feed or the cached
snapshot, so nothing downstream ever writes an `if online` check. That
decision happens here and only here.

SCOPE
  Counts only. Sensor positions and compass bearings are static metadata and
  live in grid.py, which already parses direction_1 / direction_2 out of
  sensors.csv. Nothing in this file deals with geometry.

SOURCE
  Pedestrian Counting System - Past Hour (counts per minute)
  https://data.melbourne.vic.gov.au/explore/dataset/
      pedestrian-counting-system-past-hour-counts-per-minute

  NOT the hourly dataset: that one has no directional split, and the
  counterflow term in scoring.py depends on d1 and d2 being separate.

  The feed is a rolling one-hour window refreshed roughly every 15 minutes.
  Anything older than an hour disappears, which is why every successful fetch
  writes a snapshot: it is the only copy we keep.

Run `python crowd.py` to fetch, clean and print a summary.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

import pandas as pd
import requests

# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

DATASET = "pedestrian-counting-system-past-hour-counts-per-minute"
BASE_URL = f"https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/{DATASET}/records"

PAGE_SIZE = 100          # Opendatasoft caps a single page at 100
TIMEOUT_S = 20

# The dataset holds ~160k records despite the "past hour" name, so we must ask
# for the NEWEST first rather than paging from the start. Each minute yields
# roughly one record per reporting sensor, so a handful of pages covers every
# sensor's latest reading.
ORDER_BY = "sensing_datetime desc"
MAX_PAGES = 30                  # hard stop: 3000 records
STOP_AFTER_STALE_PAGES = 3      # pages with no newly-seen sensor

SNAPSHOT = "data/snapshot.csv"   # CSV not parquet: no pyarrow dependency,
                                 # and it stays readable when debugging

# The portal has renamed fields between exports, so resolve by alias rather
# than assuming. First match wins.
ALIASES = {
    "location_id": ["location_id", "sensor_id", "locationid", "sensorid"],
    "sensing_datetime": ["sensing_datetime", "sensingdatetime", "datetime", "timestamp"],
    "direction_1": ["direction_1", "direction1"],
    "direction_2": ["direction_2", "direction2"],
    "total_of_directions": ["total_of_directions", "total_of_direction",
                            "totalofdirections", "total"],
}


# --------------------------------------------------------------------------
# The contract — agreed with Person B. Do not change without both agreeing.
# --------------------------------------------------------------------------

@dataclass(frozen=True)
class SensorLoad:
    total: int     # people per minute, both directions
    d1: int        # count in direction_1
    d2: int        # count in direction_2


_source = "unknown"


def get_all_loads(verbose: bool = False) -> dict[int, SensorLoad]:
    """Current load for every REPORTING sensor, keyed by location_id.

    A sensor may legitimately be ABSENT from this dict: the feed only creates a
    record when at least one pedestrian passes underneath. The result is never
    padded with zeros, because "no reading" and "empty street" are different
    things and the router treats them differently.
    """
    global _source
    try:
        loads = _from_live(verbose=verbose)
        _source = "live"
        return loads
    except Exception as e:
        print(f"crowd: live fetch failed ({type(e).__name__}: {e}) - using snapshot")
        try:
            loads = _from_snapshot()
            _source = "cached"
            return loads
        except Exception as e2:
            print(f"crowd: snapshot unavailable ({e2}) - returning empty")
            _source = "unavailable"
            return {}


def source() -> str:
    """'live' | 'cached' | 'unavailable' — what the last call actually returned."""
    return _source


# --------------------------------------------------------------------------
# Fetch
# --------------------------------------------------------------------------

def fetch_past_hour(verbose: bool = False) -> pd.DataFrame:
    """Fetch the most recent records, newest first.

    The dataset is far larger than one hour of data, so paging from offset 0
    would return the OLDEST rows. We sort descending and stop as soon as
    several consecutive pages bring no sensor we have not already seen, which
    means we have every sensor's latest reading.
    """
    rows: list[dict] = []
    seen: set = set()
    stale = 0

    for page in range(MAX_PAGES):
        r = requests.get(BASE_URL,
                         params={"limit": PAGE_SIZE,
                                 "offset": page * PAGE_SIZE,
                                 "order_by": ORDER_BY},
                         timeout=TIMEOUT_S)
        r.raise_for_status()
        batch = r.json().get("results", [])
        if not batch:
            break

        rows.extend(batch)
        new = {b.get("location_id") or b.get("sensor_id") for b in batch} - seen
        seen |= new
        stale = 0 if new else stale + 1

        if verbose:
            print(f"  page {page + 1}: {len(batch)} rows, "
                  f"{len(new)} new sensors, {len(seen)} total")

        if stale >= STOP_AFTER_STALE_PAGES or len(batch) < PAGE_SIZE:
            break

    if not rows:
        raise RuntimeError("feed returned no records")
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------
# Clean — the SAME function runs on live and cached data, so a fix to the
# cleaning logic applies to both paths automatically.
# --------------------------------------------------------------------------

def _resolve_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Rename whatever the portal called things to our canonical names."""
    lower = {c.lower().replace(" ", "_"): c for c in df.columns}
    rename = {}
    for canonical, options in ALIASES.items():
        for opt in options:
            if opt in lower:
                rename[lower[opt]] = canonical
                break
    missing = set(ALIASES) - set(rename.values())
    if missing:
        raise KeyError(f"columns not found: {sorted(missing)}. "
                       f"Feed returned: {sorted(df.columns)}")
    return df.rename(columns=rename)[list(ALIASES)]


def clean(df: pd.DataFrame, verbose: bool = False) -> pd.DataFrame:
    """Normalise types, drop unusable rows, remove duplicates."""
    df = _resolve_columns(df)
    before = len(df)

    df["sensing_datetime"] = pd.to_datetime(df["sensing_datetime"],
                                            utc=True, errors="coerce")
    df = df.dropna(subset=["sensing_datetime", "location_id",
                           "total_of_directions"])

    df["location_id"] = df["location_id"].astype(int)
    for c in ("direction_1", "direction_2", "total_of_directions"):
        df[c] = pd.to_numeric(df[c], errors="coerce").fillna(0).astype(int)

    # Counts cannot be negative; treat any as corrupt.
    df = df[df.total_of_directions >= 0]

    # The portal has flagged duplicate records for some sensors in the past.
    dupes = df.duplicated(subset=["location_id", "sensing_datetime"]).sum()
    df = df.drop_duplicates(subset=["location_id", "sensing_datetime"])

    if verbose:
        mismatch = (df.total_of_directions
                    != df.direction_1 + df.direction_2).sum()
        print(f"clean: {before} rows in, {len(df)} out, "
              f"{dupes} duplicates removed, "
              f"{mismatch} rows where total != d1 + d2")

    return df


def newest_per_sensor(df: pd.DataFrame) -> pd.DataFrame:
    """The feed is a rolling hour, so each sensor appears up to 60 times.
    We want current conditions, not history."""
    return (df.sort_values("sensing_datetime")
              .groupby("location_id", as_index=False)
              .tail(1))


def to_loads(df: pd.DataFrame) -> dict[int, SensorLoad]:
    return {
        int(r.location_id): SensorLoad(
            total=int(r.total_of_directions),
            d1=int(r.direction_1),
            d2=int(r.direction_2),
        )
        for r in df.itertuples()
    }


# --------------------------------------------------------------------------
# The two paths
# --------------------------------------------------------------------------

def _from_live(verbose: bool = False) -> dict[int, SensorLoad]:
    raw = fetch_past_hour(verbose=verbose)
    _save_snapshot(raw)          # cache RAW, so a later fix to clean() can be
    cleaned = clean(raw, verbose=verbose)               # re-run against it
    latest = newest_per_sensor(cleaned)
    if verbose and len(latest):
        newest = latest.sensing_datetime.max()
        age = (pd.Timestamp.now(tz="UTC") - newest).total_seconds() / 60
        print(f"  newest reading: {newest} ({age:.0f} min old)")
    return to_loads(latest)


def _from_snapshot() -> dict[int, SensorLoad]:
    if not os.path.exists(SNAPSHOT):
        raise FileNotFoundError(f"no snapshot at {os.path.abspath(SNAPSHOT)}")
    raw = pd.read_csv(SNAPSHOT)
    return to_loads(newest_per_sensor(clean(raw)))


def _save_snapshot(raw: pd.DataFrame) -> None:
    os.makedirs(os.path.dirname(SNAPSHOT) or ".", exist_ok=True)
    raw.to_csv(SNAPSHOT, index=False)


# --------------------------------------------------------------------------
# Manual check: python crowd.py
# --------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    offline = "--offline" in sys.argv

    if offline:
        print("forcing snapshot path\n")
        try:
            loads = _from_snapshot()
            _source = "cached"
        except Exception as e:
            print(f"failed: {e}")
            sys.exit(1)
    else:
        print("fetching newest records...\n")
        loads = get_all_loads(verbose=True)

    print(f"\nsource: {source()}")
    print(f"sensors reporting: {len(loads)}")

    if loads:
        totals = sorted(l.total for l in loads.values())
        n = len(totals)
        print(f"people per minute — min {totals[0]}, "
              f"median {totals[n // 2]}, max {totals[-1]}")
        print(f"mean {sum(totals) / n:.1f}")

        # Sanity check the bands against reality. Imported, not hardcoded, so
        # this stays in step with scoring.py.
        try:
            from scoring import THRESHOLDS as T
        except Exception:
            T = {"low": 50, "medium": 150}
        low = sum(1 for t in totals if t < T["low"])
        med = sum(1 for t in totals if T["low"] <= t < T["medium"])
        high = sum(1 for t in totals if t >= T["medium"])
        print(f"\nbands (low<{T['low']}, medium<{T['medium']}): "
              f"low {low}, medium {med}, high {high}")
        if max(low, med, high) > 0.8 * n:
            print("  NOTE: over 80% in one band — thresholds may need review")

        print("\nbusiest five:")
        for sid, l in sorted(loads.items(), key=lambda kv: -kv[1].total)[:5]:
            share = max(l.d1, l.d2) / l.total if l.total else 0
            print(f"   sensor {sid:>4}: {l.total:>4}/min  "
                  f"d1 {l.d1:>4}  d2 {l.d2:>4}  "
                  f"({share:.0%} one-way)")
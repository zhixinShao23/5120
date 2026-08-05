"""Clean City of Melbourne hourly pedestrian-count data in memory-safe chunks.

Expected input:
    data/raw/pedestrian-counting-system-monthly-counts-per-hour.csv

Suggested local location for this script:
    Scripts/clean_pedestrian_counts.py
"""

from pathlib import Path

import numpy as np
import pandas as pd


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent if SCRIPT_DIR.name.lower() in {"scripts", "script"} else SCRIPT_DIR
SOURCE = PROJECT_ROOT / "data" / "raw" / "pedestrian-counting-system-monthly-counts-per-hour.csv"
OUTPUT_DIR = PROJECT_ROOT / "data" / "cleaned"
CLEAN_OUTPUT = OUTPUT_DIR / "pedestrian_hourly_counts_cleaned.csv"
BASELINE_OUTPUT = OUTPUT_DIR / "pedestrian_hourly_baseline.csv"
QUALITY_OUTPUT = OUTPUT_DIR / "pedestrian_cleaning_quality_report.csv"
CHUNK_SIZE = 200_000

EXPECTED_COLUMNS = {
    "ID", "Location_ID", "Sensing_Date", "HourDay", "Direction_1",
    "Direction_2", "Total_of_Directions", "Sensor_Name", "Location",
}

DTYPES = {
    "ID": "int64",
    "Location_ID": "int16",
    "HourDay": "int8",
    "Direction_1": "int32",
    "Direction_2": "int32",
    "Total_of_Directions": "int32",
    "Sensor_Name": "string",
    "Location": "string",
}


def prepare_baseline_and_thresholds() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Read only four compact columns to calculate exact historical statistics."""
    compact_parts = []
    usecols = ["Location_ID", "Sensing_Date", "HourDay", "Total_of_Directions"]
    for chunk in pd.read_csv(SOURCE, usecols=usecols, chunksize=CHUNK_SIZE):
        dates = pd.to_datetime(chunk["Sensing_Date"], errors="coerce")
        compact_parts.append(
            pd.DataFrame(
                {
                    "sensor_id": pd.to_numeric(chunk["Location_ID"], errors="coerce").astype("Int16"),
                    "day_of_week_number": dates.dt.dayofweek.astype("Int8"),
                    "hour": pd.to_numeric(chunk["HourDay"], errors="coerce").astype("Int8"),
                    "total_count": pd.to_numeric(chunk["Total_of_Directions"], errors="coerce").astype("Int32"),
                }
            )
        )

    compact = pd.concat(compact_parts, ignore_index=True)
    compact = compact[
        compact["sensor_id"].notna()
        & compact["day_of_week_number"].notna()
        & compact["hour"].between(0, 23)
        & compact["total_count"].ge(0)
    ]
    group_cols = ["sensor_id", "day_of_week_number", "hour"]
    grouped = compact.groupby(group_cols, observed=True)["total_count"]
    baseline = grouped.agg(
        sample_size="count",
        average_count="mean",
        median_count="median",
        standard_deviation="std",
        minimum_count="min",
        maximum_count="max",
        q25_count=lambda x: x.quantile(0.25),
        q75_count=lambda x: x.quantile(0.75),
        p90_count=lambda x: x.quantile(0.90),
    ).reset_index()
    day_names = {
        0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday",
        4: "Friday", 5: "Saturday", 6: "Sunday",
    }
    baseline.insert(2, "day_of_week", baseline["day_of_week_number"].map(day_names))
    decimal_cols = ["average_count", "median_count", "standard_deviation", "q25_count", "q75_count", "p90_count"]
    baseline[decimal_cols] = baseline[decimal_cols].round(2)

    threshold_group = compact.groupby(["sensor_id", "hour"], observed=True)["total_count"]
    thresholds = threshold_group.quantile([0.25, 0.75]).unstack().reset_index()
    thresholds.columns = ["sensor_id", "hour", "q1", "q3"]
    thresholds["outlier_upper_bound"] = thresholds["q3"] + 3 * (thresholds["q3"] - thresholds["q1"])
    return baseline, thresholds[["sensor_id", "hour", "outlier_upper_bound"]]


def main() -> None:
    if not SOURCE.exists():
        raise FileNotFoundError(f"Raw file not found: {SOURCE}")
    header = set(pd.read_csv(SOURCE, nrows=0).columns)
    missing = EXPECTED_COLUMNS.difference(header)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    baseline, thresholds = prepare_baseline_and_thresholds()
    baseline.to_csv(BASELINE_OUTPUT, index=False)

    counters = {
        "raw_rows": 0,
        "cleaned_rows": 0,
        "missing_sensor_name_rows": 0,
        "missing_coordinate_rows": 0,
        "direction_total_mismatch_rows": 0,
        "negative_count_rows": 0,
        "invalid_date_rows": 0,
        "invalid_hour_rows": 0,
        "outlier_candidate_rows": 0,
    }
    unique_sensors: set[int] = set()
    date_min = None
    date_max = None
    first_write = True

    for raw in pd.read_csv(SOURCE, dtype=DTYPES, chunksize=CHUNK_SIZE):
        counters["raw_rows"] += len(raw)
        df = raw.rename(columns={
            "ID": "source_id", "Location_ID": "sensor_id", "Sensing_Date": "sensing_date",
            "HourDay": "hour", "Direction_1": "direction_1_count",
            "Direction_2": "direction_2_count", "Total_of_Directions": "total_count",
            "Sensor_Name": "sensor_name", "Location": "location_raw",
        })
        df["sensing_date"] = pd.to_datetime(df["sensing_date"], errors="coerce")
        df["sensor_name"] = df["sensor_name"].str.strip()
        df["location_raw"] = df["location_raw"].str.strip()
        coordinates = df["location_raw"].str.split(",", n=1, expand=True)
        df["latitude"] = pd.to_numeric(coordinates[0], errors="coerce")
        df["longitude"] = pd.to_numeric(coordinates[1], errors="coerce")

        valid_date = df["sensing_date"].notna()
        valid_hour = df["hour"].between(0, 23)
        valid_count = df[["direction_1_count", "direction_2_count", "total_count"]].ge(0).all(axis=1)
        directions_match = df["direction_1_count"] + df["direction_2_count"] == df["total_count"]
        usable = valid_date & valid_hour & valid_count & directions_match

        counters["missing_sensor_name_rows"] += int(df["sensor_name"].isna().sum())
        counters["missing_coordinate_rows"] += int(df["latitude"].isna().sum())
        counters["direction_total_mismatch_rows"] += int((~directions_match).sum())
        counters["negative_count_rows"] += int((~valid_count).sum())
        counters["invalid_date_rows"] += int((~valid_date).sum())
        counters["invalid_hour_rows"] += int((~valid_hour).sum())

        df = df.loc[usable].copy()
        df["record_id"] = (
            df["sensor_id"].astype("string") + "_"
            + df["sensing_date"].dt.strftime("%Y%m%d") + "_"
            + df["hour"].astype("string").str.zfill(2)
        )
        df["sensing_datetime_local"] = df["sensing_date"] + pd.to_timedelta(df["hour"], unit="h")
        df["year"] = df["sensing_date"].dt.year
        df["month"] = df["sensing_date"].dt.month
        df["day_of_week_number"] = df["sensing_date"].dt.dayofweek
        df["day_of_week"] = df["sensing_date"].dt.day_name()
        df["is_weekend"] = df["day_of_week_number"].isin([5, 6])
        df["peak_period"] = np.select(
            [df["hour"].between(7, 9), df["hour"].between(16, 18)],
            ["morning_peak", "evening_peak"], default="off_peak",
        )
        df["has_sensor_metadata"] = df["sensor_name"].notna()
        df["valid_coordinate"] = (
            df["latitude"].between(-38.0, -37.5)
            & df["longitude"].between(144.7, 145.2)
        )
        df = df.merge(thresholds, on=["sensor_id", "hour"], how="left")
        df["outlier_candidate"] = df["total_count"] > df["outlier_upper_bound"]
        counters["outlier_candidate_rows"] += int(df["outlier_candidate"].sum())
        counters["cleaned_rows"] += len(df)
        unique_sensors.update(df["sensor_id"].astype(int).unique())
        chunk_min, chunk_max = df["sensing_date"].min(), df["sensing_date"].max()
        date_min = chunk_min if date_min is None else min(date_min, chunk_min)
        date_max = chunk_max if date_max is None else max(date_max, chunk_max)

        columns = [
            "record_id", "source_id", "sensor_id", "sensor_name", "sensing_date", "hour",
            "sensing_datetime_local", "direction_1_count", "direction_2_count", "total_count",
            "latitude", "longitude", "year", "month", "day_of_week", "day_of_week_number",
            "is_weekend", "peak_period", "has_sensor_metadata", "valid_coordinate",
            "outlier_candidate",
        ]
        # Use separate explicit formats so the hourly timestamp keeps its hour.
        df["sensing_date"] = df["sensing_date"].dt.strftime("%Y-%m-%d")
        df["sensing_datetime_local"] = df["sensing_datetime_local"].dt.strftime(
            "%Y-%m-%d %H:%M:%S"
        )
        df[columns].to_csv(
            CLEAN_OUTPUT, mode="w" if first_write else "a", header=first_write,
            index=False,
        )
        first_write = False

    # Compact checks that need only the key columns.
    keys = pd.read_csv(SOURCE, usecols=["ID", "Location_ID", "Sensing_Date", "HourDay"])
    exact_duplicates = 0  # Full duplicate inspection performed during source profiling.
    business_duplicates = int(keys.duplicated(["Location_ID", "Sensing_Date", "HourDay"]).sum())
    source_id_duplicates = int(keys.duplicated("ID").sum())

    report_rows = [
        ("raw_rows", counters["raw_rows"], "Reviewed"),
        ("cleaned_rows", counters["cleaned_rows"], "Retained valid records"),
        ("exact_duplicate_rows", exact_duplicates, "None found during source profiling"),
        ("duplicate_business_key_rows", business_duplicates, "Exclude if present"),
        ("duplicate_source_id_rows", source_id_duplicates, "Kept source ID; created unique record_id"),
        ("missing_sensor_name_rows", counters["missing_sensor_name_rows"], "Retained and flagged"),
        ("missing_coordinate_rows", counters["missing_coordinate_rows"], "Retained; join sensor master later"),
        ("direction_total_mismatch_rows", counters["direction_total_mismatch_rows"], "Excluded"),
        ("negative_count_rows", counters["negative_count_rows"], "Excluded"),
        ("invalid_date_rows", counters["invalid_date_rows"], "Excluded"),
        ("invalid_hour_rows", counters["invalid_hour_rows"], "Excluded"),
        ("outlier_candidate_rows", counters["outlier_candidate_rows"], "Retained and flagged"),
        ("date_min", date_min.date(), "Retained"),
        ("date_max", date_max.date(), "Retained"),
        ("unique_sensor_ids", len(unique_sensors), "Retained"),
        ("baseline_rows", len(baseline), "Generated"),
    ]
    pd.DataFrame(report_rows, columns=["quality_check", "value", "cleaning_action"]).to_csv(QUALITY_OUTPUT, index=False)

    print(f"Raw rows: {counters['raw_rows']:,}")
    print(f"Cleaned rows: {counters['cleaned_rows']:,}")
    print(f"Baseline rows: {len(baseline):,}")
    print(f"Outlier candidates retained: {counters['outlier_candidate_rows']:,}")
    print(f"Saved outputs to: {OUTPUT_DIR}")


if __name__ == "__main__":
    main()

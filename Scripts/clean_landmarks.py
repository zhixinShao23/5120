"""Clean POI data for map markers and sub-theme-based noise classification."""

from pathlib import Path
import re

import pandas as pd


SCRIPT_DIR = Path(__file__).resolve().parent
# When this file is stored in 5120/Scripts, the project root is 5120.
# Keeping the fallback makes the script runnable from the project root too.
PROJECT_ROOT = SCRIPT_DIR.parent if SCRIPT_DIR.name.lower() == "scripts" else SCRIPT_DIR
SOURCE = PROJECT_ROOT / "data" / "raw" / "landmarks_poi_raw.csv"
OUTPUT = PROJECT_ROOT / "data" / "processed" / "landmarks_poi_noise_cleaned.csv"


# The POI dataset does not contain measured decibels. These are project-defined
# potential-noise proxy levels based on facility type. Hospitals and other
# health services are explicitly classified as low following the team's rule.
LOW = {
    "Cemetery",
    "Church",
    "Dwelling (House)",
    "Informal Outdoor Facility (Park/Garden/Reserve)",
    "Library",
    "Medical Services",
    "Private Hospital",
    "Public Hospital",
    "Synagogue",
    "Vacant Land - Undeveloped Site",
}

MEDIUM = {
    "Aquarium",
    "Art Gallery/Museum",
    "Bridge",
    "Cinema",
    "Fire Station",
    "Further Education",
    "Government Building",
    "Hostel",
    "Marina",
    "Observation Tower/Wheel",
    "Office",
    "Outdoor Recreation Facility (Zoo, Golf Course)",
    "Police Station",
    "Primary Schools",
    "Public Buildings",
    "Retail",
    "School - Primary and Secondary Education",
    "Secondary Schools",
    "Tertiary (University)",
    "Visitor Centre",
}

HIGH = {
    "Casino",
    "Current Construction Site",
    "Current Construction Site - Commercial",
    "Department Store",
    "Film & RV Studio",
    "Function/Conference/Exhibition Centre",
    "Gymnasium/Health Club",
    "Indoor Recreation Facility",
    "Industrial (Manufacturing)",
    "Major Sports & Recreation Facility",
    "Private Sports Club/Facility",
    "Railway Station",
    "Retail/Office",
    "Retail/Office/Carpark",
    "Retail/Office/Residential/Carpark",
    "Retail/Residential",
    "Store Yard",
    "Theatre Live",
    "Transport Terminal",
}

def clean_text(value: object) -> object:
    """Trim text while preserving missing values."""
    if pd.isna(value):
        return pd.NA
    return re.sub(r"\s+", " ", str(value)).strip()


def classify_noise(sub_theme: object) -> str:
    if sub_theme in LOW:
        return "low"
    if sub_theme in MEDIUM:
        return "medium"
    if sub_theme in HIGH:
        return "high"
    return "review_required"


def main() -> None:
    df = pd.read_csv(SOURCE, dtype="string")
    df.columns = [
        clean_text(column).lower().replace("-", "_").replace(" ", "_")
        for column in df.columns
    ]

    required = {"theme", "sub_theme", "feature_name", "co_ordinates"}
    missing = required.difference(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")

    for column in required:
        df[column] = df[column].map(clean_text)

    coordinates = df["co_ordinates"].str.extract(
        r"^\s*([-+]?\d+(?:\.\d+)?)\s*,\s*([-+]?\d+(?:\.\d+)?)\s*$"
    )
    df["latitude"] = pd.to_numeric(coordinates[0], errors="coerce")
    df["longitude"] = pd.to_numeric(coordinates[1], errors="coerce")
    df["valid_coordinate"] = (
        df["latitude"].between(-38.0, -37.5)
        & df["longitude"].between(144.7, 145.2)
    )
    df["usable_as_map_marker"] = df["valid_coordinate"]

    df["noise_proxy_level"] = df["sub_theme"].map(classify_noise)

    df["duplicate_name_flag"] = df.duplicated("feature_name", keep=False)
    df.insert(0, "poi_id", [f"POI{i:04d}" for i in range(1, len(df) + 1)])

    # Keep quality checks for the run summary, but do not expose these helper
    # fields in the team-facing output.
    valid_marker_count = df["usable_as_map_marker"].sum()
    invalid_coordinate_count = (~df["valid_coordinate"]).sum()
    duplicate_name_count = df["duplicate_name_flag"].sum()

    source_subthemes = set(df["sub_theme"].dropna().unique())
    configured_subthemes = LOW | MEDIUM | HIGH
    missing_rules = sorted(source_subthemes - configured_subthemes)
    unused_rules = sorted(configured_subthemes - source_subthemes)

    # The team-facing dataset contains only POIs classified as low noise.
    df = df.loc[df["noise_proxy_level"].eq("low")].copy()

    df = df[
        [
            "poi_id",
            "feature_name",
            "sub_theme",
            "latitude",
            "longitude",
            "noise_proxy_level",
        ]
    ]

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUTPUT, index=False, encoding="utf-8-sig")

    print(f"Rows written: {len(df)}")
    print(f"Valid map markers: {int(valid_marker_count)}")
    print(f"Invalid coordinates: {int(invalid_coordinate_count)}")
    print(f"Duplicate-name rows retained: {int(duplicate_name_count)}")
    print(f"Sub-themes in source: {len(source_subthemes)}")
    print(f"Sub-themes missing a noise rule: {missing_rules}")
    print(f"Configured rules not present in source: {unused_rules}")
    print("\nPOI counts by noise proxy level:")
    print(df["noise_proxy_level"].value_counts(dropna=False).to_string())
    print(f"\nOutput file: {OUTPUT}")


if __name__ == "__main__":
    main()
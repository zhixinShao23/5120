"""Clean City of Melbourne landmarks and places-of-interest data.

The script preserves every source row, standardises the schema, parses
coordinates, and adds project-specific categories and inclusion flags.
"""

from pathlib import Path
import re

import pandas as pd


PROJECT_ROOT = Path(__file__).resolve().parent.parent

SOURCE = PROJECT_ROOT / "data" / "raw" / "landmarks_poi_raw.csv"
OUTPUT = PROJECT_ROOT / "data" / "cleaned" / "landmarks_poi_cleaned.csv"

OUTPUT.parent.mkdir(parents=True, exist_ok=True)


CATEGORY_MAP = {
    "Railway Station": "transport_station",
    "Transport Terminal": "transport_station",
    "Public Hospital": "health_service",
    "Private Hospital": "health_service",
    "Medical Services": "health_service",
    "Informal Outdoor Facility (Park/Garden/Reserve)": "park_and_open_space",
    "Outdoor Recreation Facility (Zoo, Golf Course)": "park_and_open_space",
    "Tertiary (University)": "education",
    "Further Education": "education",
    "Primary Schools": "education",
    "Secondary Schools": "education",
    "School - Primary and Secondary Education": "education",
    "Theatre Live": "arts_and_culture",
    "Cinema": "arts_and_culture",
    "Art Gallery/Museum": "arts_and_culture",
    "Major Sports & Recreation Facility": "sports_and_recreation",
    "Indoor Recreation Facility": "sports_and_recreation",
    "Private Sports Club/Facility": "sports_and_recreation",
    "Place Of Assembly": "assembly_and_events",
    "Function/Conference/Exhibition Centre": "assembly_and_events",
    "Public Buildings": "public_service",
    "Library": "public_service",
    "Police Station": "public_service",
    "Fire Station": "public_service",
    "Visitor Centre": "public_service",
}

HIGH_RELEVANCE = {"transport_station", "health_service", "park_and_open_space"}
MEDIUM_RELEVANCE = {
    "education",
    "arts_and_culture",
    "sports_and_recreation",
    "assembly_and_events",
    "public_service",
}


def clean_text(value: object) -> str:
    """Trim text and collapse repeated whitespace."""
    return re.sub(r"\s+", " ", str(value)).strip()


def main() -> None:
    df = pd.read_csv(SOURCE, dtype="string")
    df.columns = [clean_text(c).lower().replace("-", "_").replace(" ", "_") for c in df.columns]

    for column in ("theme", "sub_theme", "feature_name", "co_ordinates"):
        df[column] = df[column].map(clean_text)

    coordinates = df["co_ordinates"].str.split(",", n=1, expand=True)
    df["latitude"] = pd.to_numeric(coordinates[0].str.strip(), errors="coerce")
    df["longitude"] = pd.to_numeric(coordinates[1].str.strip(), errors="coerce")

    df["project_category"] = df["sub_theme"].map(CATEGORY_MAP).fillna("other")
    df["project_relevance"] = "low"
    df.loc[df["project_category"].isin(MEDIUM_RELEVANCE), "project_relevance"] = "medium"
    df.loc[df["project_category"].isin(HIGH_RELEVANCE), "project_relevance"] = "high"
    df["include_in_mvp"] = df["project_relevance"].isin(["high", "medium"])

    # Same feature name may refer to multiple entrances or locations, so flag it
    # for review rather than deleting it.
    df["duplicate_name_flag"] = df.duplicated("feature_name", keep=False)
    df["valid_coordinate"] = (
        df["latitude"].between(-38.0, -37.5)
        & df["longitude"].between(144.7, 145.2)
    )

    df.insert(0, "poi_id", [f"POI{i:04d}" for i in range(1, len(df) + 1)])
    df = df.drop(columns="co_ordinates")
    df = df[
        [
            "poi_id",
            "feature_name",
            "theme",
            "sub_theme",
            "project_category",
            "project_relevance",
            "include_in_mvp",
            "latitude",
            "longitude",
            "valid_coordinate",
            "duplicate_name_flag",
        ]
    ].sort_values(["project_relevance", "project_category", "feature_name"], ascending=[True, True, True])

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(OUTPUT, index=False, encoding="utf-8")

    print(f"Rows written: {len(df)}")
    print(f"MVP rows: {int(df['include_in_mvp'].sum())}")
    print(f"Invalid coordinates: {int((~df['valid_coordinate']).sum())}")
    print(f"Rows with duplicated names: {int(df['duplicate_name_flag'].sum())}")
    print(df["project_category"].value_counts().to_string())


if __name__ == "__main__":
    main()

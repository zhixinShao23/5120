# Data Wrangling – Points of Interest (POI)

**Purpose:** Prepare map-ready, low-noise public facilities for the sensory-friendly journey application.

## Dataset overview

- **Source:** City of Melbourne Open Data Portal — *Landmarks and Places of Interest*
- **Input size:** 242 rows
- **Raw columns:** `Theme`, `Sub Theme`, `Feature Name`, `Co-ordinates`
- **Output file:** `landmarks_poi_noise_cleaned.csv`
- **Output size:** 84 rows containing only POIs classified as having low potential noise

## Step 1 — Column filtering and standardisation

- Retained `Feature Name`, `Sub Theme`, and `Co-ordinates` because they support map labels, facility classification, and location plotting.
- Removed `Theme` because `Sub Theme` provides the more specific facility type required by the application.
- Converted column names to code-friendly `snake_case`.
- Removed unnecessary leading, trailing, and repeated spaces from text values.

## Step 2 — Coordinate transformation and validation

- Split the original `Co-ordinates` text field into numeric `latitude` and `longitude` columns.
- Checked coordinates against a reasonable Melbourne boundary:
  - Latitude: `-38.0` to `-37.5`
  - Longitude: `144.7` to `145.2`
- Confirmed that all retained POIs have usable coordinates for map markers.

## Step 3 — Potential-noise classification

- Used `sub_theme` as the main field for classifying each public facility.
- Mapped every facility type to a project-defined noise proxy level: `low`, `medium`, or `high`.
- Following the team's design decision, the following medical facilities were explicitly classified as `low`:
  - `Public Hospital`
  - `Private Hospital`
  - `Medical Services`

> **Important:** `noise_proxy_level` represents an estimated potential-noise category based on facility type. It is not a measured sound or decibel level.

## Step 4 — Low-noise filtering and final output

- Retained only records where `noise_proxy_level = low` for the sensory-friendly POI map layer.
- Generated a stable `poi_id` before filtering so each output record remains traceable to its original POI.
- Retained 84 low-noise POIs, including all 11 hospital and medical-service records.

## Final output schema

| Field | Purpose |
|---|---|
| `poi_id` | Unique and stable POI identifier |
| `feature_name` | Facility name displayed as the map label |
| `sub_theme` | Specific public-facility type |
| `latitude` | North–south coordinate used for map plotting |
| `longitude` | East–west coordinate used for map plotting |
| `noise_proxy_level` | Estimated potential-noise category; always `low` in the final output |

## Final result

The cleaned dataset provides a compact, map-ready layer of public facilities that are estimated to have low potential noise. It can be used to display sensory-friendly places and support quieter journey planning in the application.

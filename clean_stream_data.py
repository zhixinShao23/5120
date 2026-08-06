# clean_stream_data.py
import logging
import time
from typing import Any, Dict, List, Optional
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s"
)

URL = "https://data.melbourne.vic.gov.au/api/explore/v2.1/catalog/datasets/pedestrian-counting-system-past-hour-counts-per-minute/records"


def _create_http_session() -> requests.Session:
  session = requests.Session()
  retries = Retry(
      total=3, backoff_factor=1, status_forcelist=[500, 502, 503, 504]
  )
  session.mount("https://", HTTPAdapter(max_retries=retries))
  return session


def clean_record(raw_record: Dict[str, Any]) -> Optional[Dict[str, Any]]:
  """Cleans and validates a single pedestrian record based on Melbourne API schema."""
  try:
    # 1. Location ID
    location_id = raw_record.get("location_id")

    # 2. Pedestrian Count (Key in API is 'total_of_directions')
    count = raw_record.get("total_of_directions")
    if count is None:
      count = raw_record.get("pedestrian_count") or raw_record.get("count")

    # 3. Timestamp (Key in API is 'sensing_datetime')
    timestamp = raw_record.get("sensing_datetime") or raw_record.get(
        "timestamp"
    )

    # Filter invalid/incomplete data
    if location_id is None or count is None:
      return None

    return {
        "location_id": int(location_id),
        "pedestrian_count": max(0, int(count)),
        "direction_1": int(raw_record.get("direction_1", 0)),
        "direction_2": int(raw_record.get("direction_2", 0)),
        "timestamp": str(timestamp) if timestamp else None,
        "sensing_date": raw_record.get("sensing_date"),
        "sensing_time": raw_record.get("sensing_time"),
        "ingested_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
  except (ValueError, TypeError) as err:
    logging.warning(f"Skipping malformed record: {err}")
    return None


def fetch_and_clean_batch(
    session: Optional[requests.Session] = None, limit: int = 100
) -> List[Dict[str, Any]]:
  """Fetches and cleans a single batch of records."""
  http = session or _create_http_session()
  response = http.get(URL, params={"limit": limit}, timeout=10)
  response.raise_for_status()
  print("response is ",response)
  raw_results = response.json().get("results", [])

  cleaned_records = []
  for r in raw_results:
    cleaned = clean_record(r)
    if cleaned is not None:
      cleaned_records.append(cleaned)

  return cleaned_records
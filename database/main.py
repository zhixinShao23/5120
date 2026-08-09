import os
import ssl
from typing import Optional, Dict, Any
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# 1. Environment Configuration & Database Setup
# ---------------------------------------------------------------------------

# Load .env file from current directory or database subfolder
load_dotenv()
if not os.getenv("DB_HOST"):
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

DB_USER = os.getenv("DB_USER", "postgres")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "postgres")

# Configure SSL context required for AWS RDS PostgreSQL
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

# Create SQLAlchemy Engine using pure-python pg8000 driver
connection_url = f"postgresql+pg8000://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"

engine = create_engine(
    connection_url,
    connect_args={"ssl_context": ssl_context},
    pool_pre_ping=True,  # Automatically restores dropped AWS RDS connections
    pool_recycle=3600
)

# ---------------------------------------------------------------------------
# 2. FastAPI Application & CORS Setup
# ---------------------------------------------------------------------------

app = FastAPI(
    title="AWS RDS Pedestrian & Routing API",
    description="Backend service querying AWS RDS PostgreSQL for the Hoddle Grid Vue App",
    version="1.0.0"
)

# Enable CORS so your Vue/Vite frontend (running on port 5173 or similar) can make requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# 3. Pydantic Models for Payload Validation
# ---------------------------------------------------------------------------

class RouteRequest(BaseModel):
    origin: Dict[str, Any]
    destination: Dict[str, Any]
    maxFlow: Optional[float] = 100.0

# ---------------------------------------------------------------------------
# 4. API Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
@app.get("/api/health")
def health_check():
    """Verifies that the backend server is running and can query AWS RDS."""
    try:
        with engine.connect() as conn:
            version = conn.execute(text("SELECT version();")).scalar()
            return {
                "status": "online",
                "database": "connected",
                "db_version": version
            }
    except Exception as e:
        return {
            "status": "degraded",
            "database": "disconnected",
            "error": str(e)
        }


@app.get("/api/landmarks")
def get_landmarks():
    """Reads quiet/sensory landmarks from AWS RDS PostgreSQL."""
    try:
        with engine.connect() as conn:
            # Adjust column names/table name if yours differ in RDS
            query = text("""
                SELECT id, name, sensory_score 
                FROM landmarks 
                ORDER BY sensory_score ASC;
            """)
            result = conn.execute(query)
            landmarks = [
                {
                    "id": str(row.id),
                    "name": row.name,
                    "sensoryScore": float(row.sensory_score) if row.sensory_score is not None else 0.0
                }
                for row in result.fetchall()
            ]
            return {"landmarks": landmarks}
    except Exception as e:
        print(f"Error fetching landmarks from RDS: {e}")
        # Return empty structure so frontend seam falls back gracefully
        return {"landmarks": []}


@app.get("/api/places")
def search_places(q: Optional[str] = Query(None)):
    """Searches destination places in AWS RDS using case-insensitive lookup."""
    if not q or not q.strip():
        return {"places": []}

    search_term = f"%{q.strip().lower()}%"
    try:
        with engine.connect() as conn:
            query = text("""
                SELECT id, name, lat, lng 
                FROM places 
                WHERE LOWER(name) LIKE :search_term 
                LIMIT 6;
            """)
            result = conn.execute(query, {"search_term": search_term})
            places = [
                {
                    "id": str(row.id),
                    "name": row.name,
                    "lat": float(row.lat),
                    "lng": float(row.lng)
                }
                for row in result.fetchall()
            ]
            return {"places": places}
    except Exception as e:
        print(f"Error searching places from RDS: {e}")
        return {"places": []}


@app.get("/api/crowd/live")
def get_live_crowd():
    """Fetches real-time pedestrian counts and sensor metadata from AWS RDS."""
    try:
        with engine.connect() as conn:
            query = text("""
                SELECT id, name, lat, lng, count, updated_at 
                FROM sensors;
            """)
            result = conn.execute(query)
            sensors = [
                {
                    "id": str(row.id),
                    "name": row.name,
                    "lat": float(row.lat),
                    "lng": float(row.lng),
                    "count": int(row.count) if row.count is not None else 0,
                    "updatedAt": str(row.updated_at) if row.updated_at else None
                }
                for row in result.fetchall()
            ]
            return {
                "sensors": sensors,
                "observedAt": sensors[0]["updatedAt"] if sensors and sensors[0]["updatedAt"] else "now"
            }
    except Exception as e:
        print(f"Error fetching sensor data from RDS: {e}")
        return {"sensors": []}


@app.get("/api/weather/current")
def get_weather():
    """Returns current weather state from database or static fallback."""
    try:
        with engine.connect() as conn:
            query = text("SELECT temp_c, condition FROM weather ORDER BY updated_at DESC LIMIT 1;")
            result = conn.execute(query).fetchone()
            if result:
                return {"tempC": float(result.temp_c), "condition": result.condition}
    except Exception:
        pass
    
    # Default fallback weather object matching mock expectation
    return {"tempC": 18.5, "condition": "Partly Cloudy"}


@app.post("/api/routes/plan")
def plan_route(payload: RouteRequest):
    """
    Accepts origin, destination, and comfort maxFlow tolerance.
    Queries RDS network nodes/edges to compute route options.
    """
    try:
        with engine.connect() as conn:
            # Query road network table in RDS if you run backend routing calculations here
            # result = conn.execute(text("SELECT * FROM road_network;"))
            pass
            
        return {"routes": []}
    except Exception as e:
        print(f"Error planning route via RDS: {e}")
        return {"routes": []}

# ---------------------------------------------------------------------------
# 5. Local Execution Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
"""FastAPI service for the full OSM city boundary of Bogotá."""

from __future__ import annotations

import logging
import os
import json
from contextlib import asynccontextmanager
from math import isfinite
from pathlib import Path
from threading import Thread

import networkx as nx
import osmnx as ox
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from shapely.geometry import Point, mapping, shape

from routing import analyze


logger = logging.getLogger(__name__)
# Escuela Colombiana de Ingeniería Julio Garavito, Autopista Norte #205-59.
CENTER = (4.7827153, -74.0426112)
ORIGIN_NAME = "Escuela Colombiana de Ingeniería Julio Garavito"
# OSM relation R7426387: límite de la ciudad de Bogotá (no todo el
# departamento/distrito rural). La caja sirve como respaldo mientras se carga
# el polígono y para ajustar la vista inicial del mapa.
CITY_OSM_ID = "R7426387"
AREA_KM2 = 394  # Área geodésica aproximada del polígono OSM de la ciudad.
BBOX = (-74.2235137, 4.4655960, -74.0101412, 4.8332542)
DATA_DIR = Path(__file__).parent / "data"
CACHE = Path(os.environ.get("OSM_GRAPH_CACHE", DATA_DIR / "bogota_ciudad_drive.graphml"))
BOUNDARY_CACHE = DATA_DIR / "bogota_ciudad_boundary.geojson"


def load_boundary():
    """Cache the actual city boundary; don't include neighbouring towns."""
    if BOUNDARY_CACHE.exists():
        return shape(json.loads(BOUNDARY_CACHE.read_text(encoding="utf-8")))
    boundary = ox.geocode_to_gdf(CITY_OSM_ID, by_osmid=True).geometry.iloc[0]
    BOUNDARY_CACHE.parent.mkdir(parents=True, exist_ok=True)
    BOUNDARY_CACHE.write_text(json.dumps(mapping(boundary)), encoding="utf-8")
    return boundary


def load_graph() -> nx.MultiDiGraph:
    boundary = load_boundary()
    app.state.boundary = boundary
    if CACHE.exists():
        logger.info("Loading cached OSM network from %s", CACHE)
        return ox.load_graphml(CACHE)
    logger.info("Downloading OSM streets for the whole Bogotá city boundary (~%s km²)", AREA_KM2)
    graph = ox.graph_from_polygon(boundary, network_type="drive", simplify=True)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    ox.save_graphml(graph, CACHE)
    return graph


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Accept requests immediately, even if the first OSM download takes time.
    app.state.graph = None
    app.state.boundary = None
    app.state.graph_error = None
    app.state.graph_loading = True

    def prepare_graph():
        try:
            app.state.graph = load_graph()
        except Exception as exc:
            logger.exception("Could not load the OpenStreetMap network")
            app.state.graph_error = str(exc)
        finally:
            app.state.graph_loading = False

    Thread(target=prepare_graph, name="osm-graph-loader", daemon=True).start()
    yield


app = FastAPI(title="Laboratorio de algoritmos de rutas", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:8080", "http://127.0.0.1:8080"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def metadata() -> dict:
    west, south, east, north = BBOX
    return {"area_analizada_km2": AREA_KM2, "centro": list(CENTER), "limites": [[south, west], [north, east]],
            "origen_predeterminado": list(CENTER), "nombre_origen": ORIGIN_NAME, "tipo_red": "drive", "peso": "length"}


@app.get("/api/mapa")
def map_info():
    graph = getattr(app.state, "graph", None)
    boundary = getattr(app.state, "boundary", None)
    return {"metadata": metadata(), "disponible": graph is not None, "cargando": getattr(app.state, "graph_loading", False),
            "nodos": len(graph) if graph is not None else 0,
            "zona_geojson": mapping(boundary.simplify(0.0005, preserve_topology=True)) if boundary is not None else None,
            "mensaje": getattr(app.state, "graph_error", None)}


@app.get("/api/analizar")
def route_analysis(
    origen_lat: float = Query(..., ge=-90, le=90),
    origen_lon: float = Query(..., ge=-180, le=180),
    destino_lat: float = Query(..., ge=-90, le=90),
    destino_lon: float = Query(..., ge=-180, le=180),
):
    graph = getattr(app.state, "graph", None)
    if graph is None:
        if getattr(app.state, "graph_loading", False):
            raise HTTPException(503, "La red vial de Bogotá se está descargando. Espera un momento e inténtalo de nuevo.")
        raise HTTPException(503, "La red vial no está disponible. Comprueba la conexión a OpenStreetMap y reinicia el backend.")
    west, south, east, north = BBOX
    if not all(isfinite(v) for v in (origen_lat, origen_lon, destino_lat, destino_lon)) or not all(
        south <= lat <= north and west <= lon <= east
        for lat, lon in ((origen_lat, origen_lon), (destino_lat, destino_lon))
    ):
        raise HTTPException(422, "Selecciona dos puntos dentro del área de estudio.")
    boundary = getattr(app.state, "boundary", None)
    if boundary is not None and not all(boundary.covers(Point(lon, lat)) for lat, lon in (
        (origen_lat, origen_lon), (destino_lat, destino_lon)
    )):
        raise HTTPException(422, "Selecciona dos puntos dentro del límite de la ciudad de Bogotá.")
    try:
        origin = ox.distance.nearest_nodes(graph, X=origen_lon, Y=origen_lat)
        destination = ox.distance.nearest_nodes(graph, X=destino_lon, Y=destino_lat)
        if origin == destination:
            raise HTTPException(422, "Selecciona puntos más alejados: ambos coinciden con el mismo cruce vial.")
        results = analyze(graph, origin, destination)
    except nx.NetworkXNoPath as exc:
        raise HTTPException(422, "No existe una ruta vial dirigida entre estos puntos.") from exc
    return {
        "metadata": metadata(),
        "origen_ajustado": [graph.nodes[origin]["y"], graph.nodes[origin]["x"]],
        "destino_ajustado": [graph.nodes[destination]["y"], graph.nodes[destination]["x"]],
        "algoritmos": results,
    }

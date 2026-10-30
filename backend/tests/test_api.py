from unittest.mock import patch
from time import monotonic, sleep

import networkx as nx
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from main import app, metadata


def make_graph():
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=-74.0426112, y=4.7827153)
    graph.add_node(2, x=-74.0416112, y=4.7827153)
    graph.add_edge(1, 2, length=100)
    return graph


def wait_for_graph():
    deadline = monotonic() + 2
    while app.state.graph_loading and monotonic() < deadline:
        sleep(0.01)
    assert not app.state.graph_loading


def test_api_success_and_metadata():
    graph = make_graph()
    with patch("main.load_graph", return_value=graph), patch("main.ox.distance.nearest_nodes", side_effect=[1, 2]):
        with TestClient(app) as client:
            wait_for_graph()
            info = client.get("/api/mapa").json()
            assert info["disponible"] is True
            assert info["nodos"] == 2
            response = client.get("/api/analizar", params={
                "origen_lat": 4.7827153, "origen_lon": -74.0426112,
                "destino_lat": 4.7827153, "destino_lon": -74.0416112,
            })
    assert response.status_code == 200
    assert response.json()["metadata"] == metadata()
    assert response.json()["metadata"]["nombre_origen"] == "Escuela Colombiana de Ingeniería Julio Garavito"
    assert response.json()["algoritmos"]["astar"]["distancia_m"] == 100


def test_api_rejects_outside_area_and_same_intersection():
    graph = make_graph()
    with patch("main.load_graph", return_value=graph), patch("main.ox.distance.nearest_nodes", return_value=1):
        with TestClient(app) as client:
            wait_for_graph()
            outside = client.get("/api/analizar", params={
                "origen_lat": 0, "origen_lon": 0, "destino_lat": 4.7827153, "destino_lon": -74.0416112,
            })
            same = client.get("/api/analizar", params={
                "origen_lat": 4.7827153, "origen_lon": -74.0426112,
                "destino_lat": 4.7827153, "destino_lon": -74.0416112,
            })
    assert outside.status_code == 422
    assert same.status_code == 422


def test_api_reports_unavailable_graph():
    with patch("main.load_graph", side_effect=OSError("offline")):
        with TestClient(app) as client:
            wait_for_graph()
            assert client.get("/api/mapa").json()["disponible"] is False
            response = client.get("/api/analizar", params={
                "origen_lat": 4.7827153, "origen_lon": -74.0426112,
                "destino_lat": 4.7827153, "destino_lon": -74.0416112,
            })
    assert response.status_code == 503


def test_api_rejects_point_outside_city_polygon_even_inside_bounding_box():
    graph = make_graph()
    city = Polygon([(-74.05, 4.78), (-74.04, 4.78), (-74.04, 4.79), (-74.05, 4.79)])
    with patch("main.load_graph", return_value=graph):
        with TestClient(app) as client:
            wait_for_graph()
            app.state.boundary = city
            response = client.get("/api/analizar", params={
                "origen_lat": 4.7827153, "origen_lon": -74.0426112,
                "destino_lat": 4.60, "destino_lon": -74.10,
            })
            info = client.get("/api/mapa").json()
    assert response.status_code == 422
    assert "límite" in response.json()["detail"]
    assert info["zona_geojson"]["type"] == "Polygon"

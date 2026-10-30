import networkx as nx
import pytest
from shapely.geometry import LineString

from routing import MAX_EXPLORATION_SEGMENTS, analyze, great_circle_m


def test_three_algorithms_find_optimal_route():
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=-3.704, y=40.416)
    graph.add_node(2, x=-3.703, y=40.416)
    graph.add_node(3, x=-3.702, y=40.416)
    graph.add_edge(1, 2, length=100)
    graph.add_edge(2, 3, length=100)
    graph.add_edge(1, 3, length=500)
    results = analyze(graph, 1, 3)
    assert set(results) == {"dijkstra", "astar", "bidireccional"}
    for result in results.values():
        assert result["camino"] == [[40.416, -3.704], [40.416, -3.703], [40.416, -3.702]]
        assert result["distancia_m"] == 200
        assert result["nodos_en_camino"] == 3
        assert result["nodos_explorados"] >= 1
        assert all(segment["lado"] in {"origen", "destino"} for segment in result["exploracion"])
        assert len(result["arbol_busqueda"]["aristas"]) == result["nodos_explorados"] - (2 if result["nombre"] == "Dijkstra bidireccional" else 1)
        assert result["rendimiento_ns"] >= 0


def test_great_circle_distance():
    assert great_circle_m(40.416, -3.704, 40.416, -3.704) == 0
    assert great_circle_m(40.416, -3.704, 40.416, -3.703) == pytest.approx(84.6, abs=1)


def test_geometry_follows_directed_route_even_when_stored_backwards():
    graph = nx.MultiDiGraph()
    graph.add_node(1, x=-3.704, y=40.416)
    graph.add_node(2, x=-3.702, y=40.416)
    graph.add_edge(1, 2, length=200, geometry=LineString([
        (-3.702, 40.416), (-3.703, 40.417), (-3.704, 40.416),
    ]))
    graph.add_edge(1, 2, length=300)
    results = analyze(graph, 1, 2)
    for result in results.values():
        assert result["camino"] == [[40.416, -3.704], [40.417, -3.703], [40.416, -3.702]]
        assert result["distancia_m"] == 200


def test_exploration_is_chronological_and_bounded_on_large_graph():
    graph = nx.MultiDiGraph()
    for node in range(1705):
        graph.add_node(node, x=-74.1 + node * 0.00001, y=4.7)
        if node:
            graph.add_edge(node - 1, node, length=10)
    results = analyze(graph, 0, 1704)
    for result in results.values():
        assert result["nodos_explorados"] >= 1704
        assert len(result["exploracion"]) <= MAX_EXPLORATION_SEGMENTS
        assert len(result["arbol_busqueda"]["aristas"]) > MAX_EXPLORATION_SEGMENTS
        assert all(0 <= source < len(result["arbol_busqueda"]["nodos"]) and 0 <= target < len(result["arbol_busqueda"]["nodos"])
                   for source, target, _ in result["arbol_busqueda"]["aristas"])
        assert result["exploracion"][0]["camino"][0] == [4.7, -74.1]
    assert {item["lado"] for item in results["bidireccional"]["exploracion"]} == {"origen", "destino"}

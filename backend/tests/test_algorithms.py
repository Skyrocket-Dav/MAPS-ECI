"""Comparación con NetworkX en grafos dirigidos y con calles paralelas."""

from random import Random

import networkx as nx
import pytest

from algorithms.astar import great_circle_m, shortest_path as astar_path
from algorithms.bidirectional import shortest_path as bidirectional_path
from algorithms.dijkstra import shortest_path as dijkstra_path


ALGORITHMS = (dijkstra_path, astar_path, bidirectional_path)


def path_length(graph, path):
    return sum(min(edge["length"] for edge in graph[a][b].values()) for a, b in zip(path, path[1:]))


def test_one_way_streets_and_parallel_edges():
    graph = nx.MultiDiGraph()
    for node, longitude in enumerate((-74.043, -74.042, -74.041)):
        graph.add_node(node, x=longitude, y=4.78)
    graph.add_edge(0, 1, length=100)
    graph.add_edge(0, 1, length=180)
    graph.add_edge(1, 2, length=100)
    graph.add_edge(0, 2, length=300)
    for search in ALGORITHMS:
        assert search(graph, 0, 2) == [0, 1, 2]
        assert search(graph, 1, 1) == [1]
        with pytest.raises(nx.NetworkXNoPath):
            search(graph, 2, 0)  # Una calle de sentido único no permite volver.


def test_random_street_networks_match_networkx_optimal_cost():
    random = Random(2026)
    for _ in range(20):
        graph = nx.MultiDiGraph()
        for node in range(12):
            graph.add_node(node, x=-74.05 + random.random() * 0.02, y=4.77 + random.random() * 0.02)
        for _ in range(36):
            source, target = random.sample(range(12), 2)
            a, b = graph.nodes[source], graph.nodes[target]
            # Longitud vial >= distancia geodésica: la heurística A* es admisible.
            length = great_circle_m(a["y"], a["x"], b["y"], b["x"]) + random.random() * 200
            graph.add_edge(source, target, length=length)
        for origin, destination in ((0, 10), (2, 9), (11, 1)):
            try:
                optimal = nx.shortest_path_length(graph, origin, destination, weight="length")
            except nx.NetworkXNoPath:
                for search in ALGORITHMS:
                    with pytest.raises(nx.NetworkXNoPath):
                        search(graph, origin, destination)
                continue
            for search in ALGORITHMS:
                path = search(graph, origin, destination)
                assert path[0] == origin and path[-1] == destination
                assert path_length(graph, path) == pytest.approx(optimal)

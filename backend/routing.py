"""Routing and presentation data for the Bogotá street-network laboratory."""

from __future__ import annotations

from time import perf_counter_ns

import networkx as nx

from algorithms.astar import great_circle_m, shortest_path as astar_path
from algorithms.bidirectional import shortest_path as bidirectional_path
from algorithms.dijkstra import shortest_path as dijkstra_path

MAX_EXPLORATION_SEGMENTS = 1600

ALGORITHMS = {
    "dijkstra": {
        "nombre": "Dijkstra clásico",
        "color_sugerido": "#fb7185",
        "didactica": {
            "funcionamiento": "Expande las calles por costo acumulado desde el origen, sin conocer la dirección del destino.",
            "analisis_estudiante": "Garantiza una ruta de longitud mínima con pesos no negativos. Su tiempo depende del grafo y de los puntos elegidos.",
            "caso_de_uso": "Útil como referencia y para buscar destinos cercanos desde un mismo origen.",
        },
    },
    "astar": {
        "nombre": "A* guiado",
        "color_sugerido": "#66e0c2",
        "didactica": {
            "funcionamiento": "Prioriza el costo recorrido más una estimación en línea recta hasta la meta.",
            "analisis_estudiante": "La heurística geodésica en metros guía la búsqueda sin cambiar el objetivo: minimizar la longitud vial.",
            "caso_de_uso": "Adecuado cuando se conoce un destino concreto y se dispone de una heurística espacial.",
        },
    },
    "bidireccional": {
        "nombre": "Dijkstra bidireccional",
        "color_sugerido": "#ffbc6b",
        "didactica": {
            "funcionamiento": "Busca desde el origen y desde el destino sobre las calles dirigidas en sentido inverso, hasta conectar los frentes.",
            "analisis_estudiante": "También obtiene una ruta mínima. Puede explorar menos, pero no se garantiza que gane en cada consulta pequeña.",
            "caso_de_uso": "Alternativa para consultas punto a punto en redes grandes con pesos no negativos.",
        },
    },
}


def _edge(graph: nx.MultiDiGraph, source: int, target: int) -> dict:
    return min(graph[source][target].values(), key=lambda edge: float(edge["length"]))


def _coordinates(graph: nx.MultiDiGraph, path: list[int]) -> list[list[float]]:
    """Follow actual edge geometry, including the intermediate points on curved roads."""
    coordinates: list[list[float]] = []
    for source, target in zip(path, path[1:]):
        edge = _edge(graph, source, target)
        geometry = edge.get("geometry")
        if geometry is None:
            segment = [
                (graph.nodes[source]["x"], graph.nodes[source]["y"]),
                (graph.nodes[target]["x"], graph.nodes[target]["y"]),
            ]
        else:
            segment = list(geometry.coords)
            start = graph.nodes[source]
            if (segment[-1][0] - start["x"]) ** 2 + (segment[-1][1] - start["y"]) ** 2 < (
                (segment[0][0] - start["x"]) ** 2 + (segment[0][1] - start["y"]) ** 2
            ):
                segment.reverse()
        points = [[float(lat), float(lon)] for lon, lat in segment]
        coordinates.extend(points if not coordinates else points[1:])
    return coordinates


def analyze(graph: nx.MultiDiGraph, origin: int, destination: int) -> dict:
    """Time search + tracing, then serialize a bounded sample outside the timer."""
    searches = {
        "dijkstra": dijkstra_path,
        "astar": astar_path,
        "bidireccional": bidirectional_path,
    }
    results = {}
    for key, search in searches.items():
        explored_count = 0
        trace = []

        def record(node: int, parent: int | None, side: str) -> None:
            nonlocal explored_count
            explored_count += 1
            if parent is not None:
                # Backward traversal of a directed graph uses the edge
                # node -> parent, never parent -> node.
                source, target = (parent, node) if side == "origen" else (node, parent)
                trace.append((source, target, side))

        start = perf_counter_ns()
        path = search(graph, origin, destination, on_expand=record)
        elapsed = perf_counter_ns() - start
        # The complete search tree is encoded once with shared junction
        # coordinates. Unlike the geometries below, this includes EVERY
        # expanded branch; the browser draws these straight junction-to-
        # junction links incrementally on Canvas for speed.
        tree_nodes = []
        tree_edges = []
        node_indexes = {}

        def index_for(node: int) -> int:
            if node not in node_indexes:
                node_indexes[node] = len(tree_nodes)
                attrs = graph.nodes[node]
                tree_nodes.append([round(float(attrs["y"]), 6), round(float(attrs["x"]), 6)])
            return node_indexes[node]

        for source, target, side in trace:
            tree_edges.append([index_for(source), index_for(target), 0 if side == "origen" else 1])

        if len(trace) > MAX_EXPLORATION_SEGMENTS:
            # Preserve the chronological spread of a large search without
            # sending tens of thousands of street geometries to the browser.
            last = len(trace) - 1
            trace = [trace[round(i * last / (MAX_EXPLORATION_SEGMENTS - 1))] for i in range(MAX_EXPLORATION_SEGMENTS)]
        exploration = [
            {"lado": side, "camino": _coordinates(graph, [source, target])}
            for source, target, side in trace
        ]
        distance = sum(float(_edge(graph, a, b)["length"]) for a, b in zip(path, path[1:]))
        results[key] = {
            **ALGORITHMS[key],
            "rendimiento_ns": elapsed,
            "rendimiento_ms": round(elapsed / 1_000_000, 4),
            "nodos_en_camino": len(path),
            "nodos_explorados": explored_count,
            "arbol_busqueda": {"nodos": tree_nodes, "aristas": tree_edges},
            "exploracion": exploration,
            "distancia_m": round(distance, 2),
            "camino": _coordinates(graph, path),
        }
    return results

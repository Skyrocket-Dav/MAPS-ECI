"""A*: Dijkstra guiado por una estimación geográfica del destino.

Usa la misma longitud vial real ``g`` que Dijkstra, pero ordena la búsqueda
con ``f = g + h``. Aquí ``h`` es la distancia en línea recta sobre la Tierra.
Como una ruta por calles no puede ser más corta que esa línea recta, la
heurística es una cota inferior en METROS para el peso ``length``.
"""

from heapq import heappop, heappush
from itertools import count
from math import asin, cos, inf, radians, sin, sqrt
from typing import Callable

import networkx as nx


def great_circle_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distancia geodésica en metros, con el radio terrestre usado por OSMnx."""
    radius = 6_371_009.0
    phi1, phi2 = radians(lat1), radians(lat2)
    delta_phi, delta_lambda = phi2 - phi1, radians(lon2 - lon1)
    a = sin(delta_phi / 2) ** 2 + cos(phi1) * cos(phi2) * sin(delta_lambda / 2) ** 2
    return 2 * radius * asin(min(1.0, sqrt(a)))


def shortest_path(
    graph: nx.MultiDiGraph, origin: int, destination: int,
    on_expand: Callable[[int, int | None, str], None] | None = None,
) -> list[int]:
    """Busca una ruta mínima priorizando los cruces prometedores."""
    if origin not in graph or destination not in graph:
        raise nx.NodeNotFound("El origen o el destino no pertenece al grafo")

    # PASO 1. g(n) es la distancia REAL recorrida hasta n; h(n) estima lo
    # que falta. La cola ordena por f(n) = g(n) + h(n), no solo por g(n).
    goal = graph.nodes[destination]

    def heuristic(node: int) -> float:
        here = graph.nodes[node]
        return great_circle_m(here["y"], here["x"], goal["y"], goal["x"])

    best_g = {origin: 0.0}
    previous = {}
    order = count()
    queue = [(heuristic(origin), next(order), 0.0, origin)]

    while queue:
        # PASO 2. Elegimos el cruce de menor f. Ignoramos entradas antiguas
        # cuando ya encontramos otra forma más barata de llegar a ese cruce.
        _, _, traveled, node = heappop(queue)
        if traveled > best_g[node]:
            continue
        if on_expand is not None:
            on_expand(node, previous.get(node), "origen")

        # PASO 3. La heurística nunca sobrestima el costo restante; por eso
        # extraer el destino de la cola da una ruta mínima por longitud.
        if node == destination:
            path = [node]
            while node != origin:
                node = previous[node]
                path.append(node)
            return path[::-1]

        # PASO 4. Recorremos solo calles salientes. Si mejoramos g del vecino,
        # guardamos de dónde venimos y recalculamos su prioridad g + h.
        for neighbor, parallel_edges in graph.adj[node].items():
            length = min(float(edge["length"]) for edge in parallel_edges.values())
            if length < 0:
                raise ValueError("A* requiere longitudes no negativas")
            candidate_g = traveled + length
            if candidate_g < best_g.get(neighbor, inf):
                best_g[neighbor] = candidate_g
                previous[neighbor] = node
                heappush(queue, (candidate_g + heuristic(neighbor), next(order), candidate_g, neighbor))

    # PASO 5. Si no queda ningún cruce pendiente, no existe ruta dirigida.
    raise nx.NetworkXNoPath(f"No hay camino entre {origin} y {destination}")

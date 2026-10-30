"""Dijkstra clásico: ruta más corta sin información sobre el destino.

Cada nodo representa un cruce y cada arista una calle transitable en su
sentido permitido. El peso ``length`` es su longitud en metros. En un
MultiDiGraph puede haber varias calles entre el mismo par de cruces: usamos
la más corta, igual que hará el serializador de la ruta.
"""

from heapq import heappop, heappush
from itertools import count
from math import inf
from typing import Callable

import networkx as nx


def shortest_path(
    graph: nx.MultiDiGraph, origin: int, destination: int,
    on_expand: Callable[[int, int | None, str], None] | None = None,
) -> list[int]:
    """Encuentra un camino mínimo usando solo pesos no negativos."""
    if origin not in graph or destination not in graph:
        raise nx.NodeNotFound("El origen o el destino no pertenece al grafo")

    # PASO 1. La mejor distancia conocida al origen es cero. Las demás
    # distancias aún se consideran infinitas; `previous` permitirá reconstruir
    # el camino al terminar.
    distance = {origin: 0.0}
    previous = {}
    settled = set()
    order = count()
    queue = [(0.0, next(order), origin)]

    while queue:
        # PASO 2. Tomamos el cruce con el MENOR costo acumulado. El contador
        # evita comparar identificadores de nodos cuando hay costos iguales.
        current_cost, _, node = heappop(queue)
        if node in settled:
            continue  # Una entrada antigua de la cola ya no aporta nada.
        settled.add(node)
        # Registramos el cruce que realmente se extrajo, no los candidatos
        # que solo se insertaron en la cola. Su arista padre muestra por
        # dónde llegó la búsqueda a esta parte del grafo vial.
        if on_expand is not None:
            on_expand(node, previous.get(node), "origen")

        # PASO 3. Al extraer el destino, su distancia ya es definitiva:
        # todos los pesos son no negativos, así que ninguna ruta posterior
        # podría hacerlo más barato.
        if node == destination:
            path = [node]
            while node != origin:
                node = previous[node]
                path.append(node)
            return path[::-1]

        # PASO 4. "Relajamos" cada calle SALIENTE. En un grafo vial dirigido
        # no podemos atravesar una calle de sentido único hacia atrás.
        for neighbor, parallel_edges in graph.adj[node].items():
            length = min(float(edge["length"]) for edge in parallel_edges.values())
            if length < 0:
                raise ValueError("Dijkstra requiere longitudes no negativas")
            candidate = current_cost + length
            if candidate < distance.get(neighbor, inf):
                distance[neighbor] = candidate
                previous[neighbor] = node
                heappush(queue, (candidate, next(order), neighbor))

    # PASO 5. Si la cola se agotó sin extraer el destino, no hay ruta dirigida.
    raise nx.NetworkXNoPath(f"No hay camino entre {origin} y {destination}")

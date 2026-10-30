"""Dijkstra bidireccional: dos búsquedas simultáneas, sin heurística A*.

La búsqueda frontal sigue calles SALIENTES desde el origen. La búsqueda
trasera sigue calles ENTRANTES desde el destino: así representa rutas que
realmente pueden llegar allí respetando los sentidos únicos.
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
    """Encuentra una ruta mínima al conectar dos frentes de Dijkstra."""
    if origin not in graph or destination not in graph:
        raise nx.NodeNotFound("El origen o el destino no pertenece al grafo")
    if origin == destination:
        return [origin]

    # PASO 1. Cada frente tiene su propia distancia y cola. `previous`
    # reconstruye origen -> encuentro; `next_to_goal`, encuentro -> destino.
    forward = {origin: 0.0}
    backward = {destination: 0.0}
    previous = {}
    next_to_goal = {}
    settled_forward, settled_backward = set(), set()
    order = count()
    front_queue = [(0.0, next(order), origin)]
    back_queue = [(0.0, next(order), destination)]
    best_cost, meeting = inf, None

    while front_queue and back_queue:
        # PASO 2. Si ni el menor costo pendiente de cada lado, sumados,
        # puede mejorar una ruta completa ya encontrada, hemos terminado.
        # No basta con parar cuando los frentes se tocan por primera vez:
        # ese primer encuentro podría no ser el más corto.
        if front_queue[0][0] + back_queue[0][0] >= best_cost:
            break

        # PASO 3. Expandimos el frente con menor costo pendiente. Desde el
        # destino usamos `graph.pred` (calles entrantes), nunca sus salientes.
        going_forward = front_queue[0][0] <= back_queue[0][0]
        queue = front_queue if going_forward else back_queue
        known = forward if going_forward else backward
        opposite = backward if going_forward else forward
        settled = settled_forward if going_forward else settled_backward
        neighbors = graph.adj if going_forward else graph.pred

        cost, _, node = heappop(queue)
        if node in settled:
            continue
        settled.add(node)
        # El frente inverso registra calles que conducen HACIA el destino.
        # Así se pueden colorear ambos frentes por separado en el mapa.
        if on_expand is not None:
            parent = previous.get(node) if going_forward else next_to_goal.get(node)
            on_expand(node, parent, "origen" if going_forward else "destino")

        # PASO 4. Si el otro frente conoce este cruce, tenemos una ruta
        # completa candidata. Aún podrían existir otras rutas mejores.
        if node in opposite and cost + opposite[node] < best_cost:
            best_cost, meeting = cost + opposite[node], node

        # PASO 5. Relajamos las calles en la dirección de ESTE frente.
        for neighbor, parallel_edges in neighbors[node].items():
            length = min(float(edge["length"]) for edge in parallel_edges.values())
            if length < 0:
                raise ValueError("Dijkstra bidireccional requiere longitudes no negativas")
            candidate = cost + length
            if candidate < known.get(neighbor, inf):
                known[neighbor] = candidate
                if going_forward:
                    previous[neighbor] = node
                else:
                    next_to_goal[neighbor] = node
                heappush(queue, (candidate, next(order), neighbor))

            # Encontrar un cruce conocido en ambos sentidos da una cota
            # superior del costo total: guardamos la mejor para el PASO 2.
            if neighbor in opposite and known[neighbor] + opposite[neighbor] < best_cost:
                best_cost, meeting = known[neighbor] + opposite[neighbor], neighbor

    if meeting is None:
        raise nx.NetworkXNoPath(f"No hay camino entre {origin} y {destination}")

    # PASO 6. Unimos la mitad frontal y la trasera sin repetir el cruce donde
    # se encontraron. La longitud de esta ruta es `best_cost`.
    left = [meeting]
    while left[-1] != origin:
        left.append(previous[left[-1]])
    left.reverse()
    right = []
    node = meeting
    while node != destination:
        node = next_to_goal[node]
        right.append(node)
    return left + right

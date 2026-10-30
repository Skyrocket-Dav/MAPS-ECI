# RutaLab — laboratorio geográfico de algoritmos de rutas

Una herramienta didáctica para comparar Dijkstra, A* y Dijkstra bidireccional sobre la red de calles **dirigida** de toda la **ciudad de Bogotá** (~394 km² según el límite urbano OSM). La **Escuela Colombiana de Ingeniería Julio Garavito** es el origen predeterminado. FastAPI conserva el grafo OSM en memoria; Vue y Leaflet permiten elegir un destino y animar sucesivamente los tres caminos.

Para estudiar o modificar la interfaz, empieza por la [guía del frontend](frontend/README.md): explica sus archivos, el flujo de datos y cómo verificar los cambios.

## Requisitos

- Python 3.10+ (se recomienda 3.11 o 3.12 para disponer de ruedas binarias de dependencias geoespaciales)
- Node.js 20.19+ y npm
- Conexión a Internet en el primer arranque del backend (Overpass/OpenStreetMap) y para los mosaicos del mapa

## Inicio rápido

En dos terminales, desde la raíz del proyecto:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate              # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

```bash
cd frontend
npm install
npm run dev
```

Abre **http://localhost:5173**. El primer arranque consulta el límite OSM de la ciudad (relación `R7426387`) y descarga la red vial; es una descarga considerablemente mayor que la versión anterior y puede tardar varios minutos. El límite y el grafo se guardan en `backend/data/bogota_ciudad_boundary.geojson` y `backend/data/bogota_ciudad_drive.graphml`; los siguientes arranques reutilizan estos archivos. Si la descarga falla, comprueba la conexión y reinicia el backend. Se puede cambiar la ruta del grafo con `OSM_GRAPH_CACHE`, pero no reutilices una caché del área anterior.

La cobertura corresponde al **polígono de la ciudad de Bogotá en OpenStreetMap**, no a todas las zonas rurales del Distrito Capital ni a municipios vecinos. Solo se admiten puntos dentro de ese polígono y sobre la red de calles transitables en automóvil.

**Si aparece «No se pudo conectar con el backend»**, asegúrate de mantener abierta la terminal de FastAPI (`uvicorn main:app --reload`) además de la de Vite. Comprueba `http://127.0.0.1:8000/api/mapa`: `cargando: true` significa que el servidor ya responde pero está descargando OSM; `disponible: true` significa que puedes analizar rutas. El frontend reintenta consultar el estado automáticamente.

1. El origen comienza en la **Escuela Colombiana de Ingeniería** (4.7827153, -74.0426112). Puedes cambiarlo seleccionando **Origen** y haciendo clic dentro del límite punteado de Bogotá.
2. Haz clic dentro del límite para escoger un **Destino**.
3. Pulsa **Analizar rutas** (en pantallas pequeñas también hay un botón sobre el mapa). Para cada algoritmo se animan primero **todas las ramas del árbol de búsqueda** en el orden en que se expandieron los nodos y después se dibuja el camino óptimo con las ramas atenuadas. En Dijkstra bidireccional, el frente desde el destino aparece en azul. Al terminar, se destaca el algoritmo con menor tiempo de búsqueda de esa ejecución. Pulsa **Reproducir comparación** para repetir, selecciona un algoritmo para ver solo su exploración o usa **Ocultar/Mostrar ramas** para inspeccionar la ruta principal. Los análisis aparecen como **ventanas flotantes sobre el mapa**: arrastra su encabezado (o usa las flechas del teclado), minimízalas por separado o escóndelas con **Ocultar análisis** en la cabecera.

En escritorio, usa la flecha del borde del menú lateral para **contraerlo o expandirlo**. El mapa aprovecha el espacio libre; en móvil los controles permanecen debajo del mapa.

## API

- `GET /api/mapa`: límites, polígono simplificado de la ciudad, centro y disponibilidad de la red.
- `GET /api/analizar?origen_lat=4.7827153&origen_lon=-74.0426112&destino_lat=4.779&destino_lon=-74.04`: ajusta ambos puntos al cruce vial más cercano y devuelve `metadata`, `origen_ajustado`, `destino_ajustado` y `algoritmos`. Cada algoritmo incluye `rendimiento_ns`, `rendimiento_ms`, `nodos_en_camino`, `nodos_explorados`, `distancia_m`, `camino` (coordenadas `[lat, lon]`), `arbol_busqueda` (todos los cruces compartidos en `nodos` y aristas `[índice_origen, índice_destino, lado]`, donde 0 es el frente desde A y 1 desde B), `exploracion` (muestra de geometrías viales) y `didactica`.
- Documentación interactiva: **http://localhost:8000/docs**.

El peso utilizado es `length` (metros). Los algoritmos están implementados explícitamente sobre el `MultiDiGraph` de NetworkX en **`backend/algorithms/dijkstra.py`**, **`backend/algorithms/astar.py`** y **`backend/algorithms/bidirectional.py`**. Cada archivo explica paso a paso su cola, los costos y la reconstrucción del camino; `backend/routing.py` mide la búsqueda y prepara la respuesta JSON. La tercera opción es específicamente **Dijkstra bidireccional**, no A* bidireccional. La heurística A* es la distancia geodésica al destino. Se mide la búsqueda **incluyendo el registro de nodos expandidos**, pero no el ajuste a la red ni la generación de geometría. Las mediciones son de **una ejecución** y pueden fluctuar. El frontend dibuja el árbol **completo** en un lienzo incremental sin crear miles de capas Leaflet. Las ramas del árbol se representan como líneas rectas entre cruces para que el envío de datos sea compacto; la ruta principal sí sigue la geometría vial real. El campo opcional `exploracion` conserva una muestra de hasta 1600 segmentos con geometría vial. El mapa muestra aristas que condujeron a nodos expandidos, no todos los candidatos de la cola. La duración visual de la animación no representa milisegundos de cómputo ni tiempo de viaje. Rutas óptimas de igual longitud pueden tener trazados diferentes y `nodos_en_camino` no es igual a `nodos_explorados`.

Para experimentar con tiempos de viaje, se deben añadir velocidades y tiempos a las aristas del grafo con OSMnx (`add_edge_speeds`, `add_edge_travel_times`), cambiar **los tres** pesos a `travel_time` y adaptar la heurística de A* a una cota inferior en segundos (o usar cero). Cambiar solo el nombre del peso sin precalcularlo o mantener una heurística en metros no es correcto.

## Verificación

```bash
cd backend && python -m pytest
cd frontend && npm run build
```

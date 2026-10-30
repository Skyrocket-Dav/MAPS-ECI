# Frontend de RutaLab: guía para estudiantes

Este frontend usa **Vue 3 + Vite** para la interfaz, **Leaflet** para el mapa y **Chart.js** para comparar tiempos. El backend FastAPI calcula las rutas: el navegador solo solicita datos y los representa.

## Ejecutar y comprobar

Desde `frontend/`:

```bash
npm install
npm run dev
npm run build
```

Abre `http://localhost:5173`. Para analizar rutas también debes iniciar el backend (consulta el [README principal](../README.md)). Vite envía las peticiones `/api/*` al servidor FastAPI; la configuración está en `vite.config.js`. Los mosaicos de OpenStreetMap necesitan conexión a Internet.

## Ruta de lectura recomendada

1. `src/main.js` monta `App.vue` e importa los estilos globales.
2. `src/App.vue` coordina el mapa, los puntos elegidos, las solicitudes al backend y las animaciones. Lee primero `choosePoint`, `analyze` y `playComparison`; después, `showExploration` y `showRoute`.
3. `src/explorationCanvas.js` pinta incrementalmente el árbol de búsqueda en un lienzo sobre Leaflet. Así evitamos crear una capa Leaflet por cada una de las miles de aristas.
4. `src/AnalysisWindows.vue` muestra la comparación de tiempos y la explicación del algoritmo activo. Recibe los resultados como *props*; no hace solicitudes HTTP.
5. `src/useFloatingPanels.js` contiene únicamente la interacción de las ventanas: arrastrar, mover con flechas, minimizar y mantenerlas dentro del mapa.
6. `src/style.css` define la apariencia y las adaptaciones para escritorio y móvil. Las reglas de las ventanas flotantes están al final del archivo.

## Qué pasa cuando analizas una ruta

```text
clic en el mapa → choosePoint → origen/destino en App.vue
botón Analizar → GET /api/analizar → results
results → playComparison → showExploration → ExplorationCanvas
                             → showRoute → polilínea Leaflet
        → AnalysisWindows → gráfica y explicación
```

- Las coordenadas para Leaflet y los puntos de `camino` son `[latitud, longitud]`. Las coordenadas del GeoJSON del límite son `[longitud, latitud]`; `pointInRing` respeta esa diferencia.
- `arbol_busqueda.nodos` guarda cruces compartidos y `aristas` guarda pares de índices y el frente de búsqueda (`0` desde el origen, `1` desde el destino). La animación del árbol dibuja las aristas en el orden recibido.
- `camino` representa la ruta final siguiendo las calles. Se anima por **distancia acumulada**, no por número de vértices, para que un tramo con más puntos no parezca más lento.
- `animationToken` cancela visualmente callbacks anteriores al cambiar de algoritmo o ruta. `requestId` evita mostrar una respuesta HTTP obsoleta tras limpiar la ruta.
- En escritorio, `sidebarCollapsed` cambia el menú lateral por una barra estrecha. El `ResizeObserver` de `App.vue` llama a `map.invalidateSize()` para que Leaflet aproveche el espacio recuperado; en móvil los controles siguen visibles debajo del mapa.
- «Más rápido» compara `rendimiento_ns` de **una búsqueda medida**, no tiempo de viaje. La velocidad de reproducción de la animación es solo visual.

## Cambios habituales

- **Texto, colores o orden de algoritmos:** revisa `definitions` en `App.vue`. Los identificadores deben coincidir con las claves de `algoritmos` devueltas por la API.
- **Diseño de las ventanas:** edita `AnalysisWindows.vue` y las reglas `.floating-*` de `style.css`. La lógica de movimiento queda en `useFloatingPanels.js`.
- **Duración de la animación:** `showExploration` y `showRoute` en `App.vue`. Respeta `prefers-reduced-motion` y no confundas duración visual con rendimiento medido.
- **Datos de la API:** consulta el contrato de `/api/mapa` y `/api/analizar` en el [README principal](../README.md) y en `http://localhost:8000/docs` con el backend activo.

Después de cualquier cambio, ejecuta `npm run build` y prueba una ruta en escritorio y móvil: selección de puntos, comparación, minimización, arrastre y ocultar/mostrar ventanas.

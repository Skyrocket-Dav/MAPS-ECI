<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import axios from 'axios'
import L from 'leaflet'
import AnalysisWindows from './AnalysisWindows.vue'
import { ExplorationCanvas } from './explorationCanvas.js'

const center = [4.7827153, -74.0426112]
const defaultBounds = [[4.465596, -74.2235137], [4.8332542, -74.0101412]]
const schoolName = 'Escuela Colombiana de Ingeniería'
const desktopMediaQuery = window.matchMedia('(min-width: 901px)')
const definitions = [
  { key: 'dijkstra', number: '01', name: 'Dijkstra', type: 'BÚSQUEDA RADIAL', color: '#fb7185', icon: '◎', short: 'Explora desde el origen sin conocer la dirección de la meta.' },
  { key: 'astar', number: '02', name: 'A*', type: 'BÚSQUEDA GUIADA', color: '#66e0c2', icon: '↗', short: 'Una heurística geográfica guía la búsqueda hacia el destino.' },
  { key: 'bidireccional', number: '03', name: 'Bidireccional', type: 'DOS FRENTES', color: '#ffbc6b', icon: '⇄', short: 'Dos búsquedas avanzan desde extremos opuestos.' },
]

// Datos visibles en la interfaz. Vue actualiza la vista cuando cambia un ref.
const mapElement = ref(null)
const mapInfo = ref(null)
const origin = ref([...center])
const destination = ref(null)
const results = ref(null)
const activeAlgorithm = ref('astar')
const selection = ref('destination')
const loading = ref(false)
const error = ref('')
const animationProgress = ref(0)
const animationPlaying = ref(false)
const comparePlaying = ref(false)
const branchesVisible = ref(true)
const analysisVisible = ref(true)
const sidebarCollapsed = ref(false)
const desktopLayout = ref(desktopMediaQuery.matches)
const sidebarIsCollapsed = computed(() => desktopLayout.value && sidebarCollapsed.value)
const animationPhase = ref('exploracion')

// Objetos de Leaflet: no son estado de Vue y se crean al montar el componente.
let map, areaLayer, markerLayer, routeLayer, explorationLayer, explorationCanvas
let resizeObserver
let backendRetryTimer
let requestId = 0
let boundaryLoaded = false
let animationFrame, animationTimer, animationToken = 0

function updateDesktopLayout(event) {
  desktopLayout.value = event.matches
}

const ready = computed(() => Boolean(origin.value && destination.value))
const selectedResult = computed(() => results.value?.algoritmos?.[activeAlgorithm.value])
const currentExplored = computed(() => animationPhase.value === 'exploracion' && animationPlaying.value
  ? Math.round((selectedResult.value?.nodos_explorados ?? 0) * animationProgress.value / 100)
  : selectedResult.value?.nodos_explorados ?? 0)
const fastest = computed(() => {
  if (!results.value) return null
  return Object.entries(results.value.algoritmos).reduce((best, current) => current[1].rendimiento_ns < best[1].rendimiento_ns ? current : best)[0]
})

function formatPoint(point) {
  if (point && point[0] === center[0] && point[1] === center[1]) return schoolName
  return point ? `${point[0].toFixed(5)}, ${point[1].toFixed(5)}` : 'Haz clic en el mapa'
}

function markerIcon(label, className) {
  return L.divIcon({ className: '', html: `<div class="map-pin ${className}"><span>${label}</span></div>`, iconSize: [34, 42], iconAnchor: [17, 40] })
}

function pointInRing(point, ring) {
  const [lat, lon] = point
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[j]
    if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) inside = !inside
  }
  return inside
}

function pointInCity(point) {
  const geometry = mapInfo.value?.zona_geojson
  if (!geometry) return areaLayer.getBounds().contains(L.latLng(point))
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates]
  return polygons.some(rings => pointInRing(point, rings[0]) && !rings.slice(1).some(hole => pointInRing(point, hole)))
}

function drawMarkers() {
  if (!markerLayer) return
  markerLayer.clearLayers()
  if (origin.value) L.marker(origin.value, { icon: markerIcon('A', 'pin-origin') }).addTo(markerLayer)
  if (destination.value) L.marker(destination.value, { icon: markerIcon('B', 'pin-destination') }).addTo(markerLayer)
}

// Un token invalida callbacks de animaciones anteriores al cambiar de ruta.
function stopAnimation() {
  animationToken++
  cancelAnimationFrame(animationFrame)
  clearTimeout(animationTimer)
  animationPlaying.value = false
  comparePlaying.value = false
  animationProgress.value = 0
}

// Primero se dibuja el árbol de búsqueda y después la ruta elegida.
function showExploration(key, progress = 1, onComplete = null, token = animationToken) {
  explorationLayer.clearLayers()
  routeLayer.clearLayers()
  animationPhase.value = 'exploracion'
  const tree = results.value?.algoritmos[key]?.arbol_busqueda ?? { nodos: [], aristas: [] }
  const color = definitions.find(item => item.key === key).color
  explorationCanvas.setTree(tree, color)
  explorationCanvas.setDimmed(false)
  branchesVisible.value = true
  explorationCanvas.setVisible(true)
  const frontTip = L.circleMarker(results.value.origen_ajustado, { radius: 7, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(explorationLayer)
  const backTip = key === 'bidireccional'
    ? L.circleMarker(results.value.destino_ajustado, { radius: 7, color: '#fff', weight: 2, fillColor: '#8ab6ff', fillOpacity: 1, interactive: false }).addTo(explorationLayer)
    : null

  function draw(fraction) {
    const count = Math.min(tree.aristas.length, Math.ceil(tree.aristas.length * fraction))
    explorationCanvas.drawTo(count)
    if (count) {
      const [source, target, side] = tree.aristas[count - 1]
      const tip = side === 1 ? backTip : frontTip
      tip?.setLatLng(tree.nodos[side === 1 ? source : target])
    }
    animationProgress.value = Math.round(fraction * 100)
  }

  if (progress >= 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    draw(1)
    onComplete?.()
    return
  }
  animationPlaying.value = true
  let started, lastPaint = 0
  function frame(time) {
    if (token !== animationToken) return
    started ??= time
    const fraction = Math.min(1, (time - started) / 2000)
    if (time - lastPaint >= 40 || fraction === 1) {
      draw(fraction)
      lastPaint = time
    }
    if (fraction < 1) animationFrame = requestAnimationFrame(frame)
    else onComplete?.()
  }
  animationFrame = requestAnimationFrame(frame)
}

function animateAlgorithm(key, token = animationToken, onComplete = null) {
  showExploration(key, 0, () => {
    if (token !== animationToken) return
    explorationLayer.clearLayers()
    explorationCanvas.setDimmed(true)
    animationPhase.value = 'ruta'
    showRoute(key, 0, onComplete, token)
  }, token)
}

function showRoute(key, progress = 1, onComplete = null, token = animationToken) {
  if (!routeLayer) return
  routeLayer.clearLayers()
  const points = results.value?.algoritmos[key]?.camino
  if (!points?.length) return
  const color = definitions.find(item => item.key === key).color
  L.polyline(points, { color, weight: 4, opacity: 0.24, dashArray: '5 9', interactive: false }).addTo(routeLayer)
  const shadow = L.polyline([], { color: '#081a2a', weight: 11, opacity: 0.83, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer)
  const line = L.polyline([], { color, weight: 6, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(routeLayer)
  const tip = L.circleMarker(points[0], { radius: 8, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(routeLayer)

  // Avanzamos por DISTANCIA sobre la polilínea, no por índice de vértice:
  // una calle con muchos puntos de geometría no se dibuja artificialmente lenta.
  const cumulative = [0]
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + L.latLng(points[i - 1]).distanceTo(points[i]))
  const total = cumulative[cumulative.length - 1]
  function draw(fraction) {
    const distance = total * fraction
    let low = 0, high = points.length - 1
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (cumulative[mid] < distance) low = mid + 1
      else high = mid
    }
    const index = Math.max(1, low)
    const length = cumulative[index] - cumulative[index - 1]
    const ratio = length ? Math.max(0, Math.min(1, (distance - cumulative[index - 1]) / length)) : 1
    const end = [
      points[index - 1][0] + (points[index][0] - points[index - 1][0]) * ratio,
      points[index - 1][1] + (points[index][1] - points[index - 1][1]) * ratio,
    ]
    const visible = fraction >= 1 ? points : [...points.slice(0, index), end]
    shadow.setLatLngs(visible)
    line.setLatLngs(visible)
    tip.setLatLng(end)
    animationProgress.value = Math.round(fraction * 100)
  }

  if (progress >= 1 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    draw(1)
    routeLayer.removeLayer(tip)
    onComplete?.()
    return
  }
  animationPlaying.value = true
  let started
  function frame(time) {
    if (token !== animationToken) return
    started ??= time
    const fraction = Math.min(1, (time - started) / 1800)
    draw(fraction)
    if (fraction < 1) animationFrame = requestAnimationFrame(frame)
    else {
      routeLayer.removeLayer(tip)
      animationPlaying.value = false
      onComplete?.()
    }
  }
  animationFrame = requestAnimationFrame(frame)
}

function selectAlgorithm(key) {
  stopAnimation()
  activeAlgorithm.value = key
  if (results.value) animateAlgorithm(key)
}

function toggleBranches() {
  branchesVisible.value = !branchesVisible.value
  explorationCanvas.setVisible(branchesVisible.value)
}


function playComparison() {
  if (!results.value) return
  stopAnimation()
  const token = animationToken
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    activeAlgorithm.value = fastest.value
    showExploration(fastest.value)
    explorationLayer.clearLayers()
    explorationCanvas.setDimmed(true)
    animationPhase.value = 'ruta'
    showRoute(fastest.value)
    return
  }
  comparePlaying.value = true
  let index = 0
  function next() {
    if (token !== animationToken) return
    if (index === definitions.length) {
      comparePlaying.value = false
      activeAlgorithm.value = fastest.value
      showExploration(fastest.value)
      explorationLayer.clearLayers()
      explorationCanvas.setDimmed(true)
      animationPhase.value = 'ruta'
      showRoute(fastest.value)
      return
    }
    const key = definitions[index++].key
    activeAlgorithm.value = key
    animateAlgorithm(key, token, () => { animationTimer = setTimeout(next, 450) })
  }
  next()
}

function clearResultLayers() {
  routeLayer.clearLayers()
  explorationLayer.clearLayers()
  explorationCanvas.setTree({ nodos: [], aristas: [] }, '#fff')
}

function choosePoint(point) {
  if (loading.value) return
  if (!pointInCity(point)) {
    error.value = 'Selecciona un punto dentro del límite de la ciudad de Bogotá.'
    return
  }
  error.value = ''
  stopAnimation()
  results.value = null
  if (selection.value === 'origin') {
    origin.value = point
    if (!destination.value) selection.value = 'destination'
  } else {
    destination.value = point
    if (!origin.value) selection.value = 'origin'
  }
  drawMarkers()
  clearResultLayers()
}

function swapPoints() {
  if (!ready.value) return
  stopAnimation()
  const previous = origin.value
  origin.value = destination.value
  destination.value = previous
  results.value = null
  error.value = ''
  drawMarkers()
  clearResultLayers()
}

function reset() {
  requestId++
  stopAnimation()
  origin.value = [...center]
  destination.value = null
  results.value = null
  error.value = ''
  loading.value = false
  selection.value = 'destination'
  drawMarkers()
  clearResultLayers()
}

async function analyze() {
  if (!ready.value || loading.value) return
  stopAnimation()
  // Si el usuario limpia la ruta mientras llega la respuesta, ignoramos la respuesta antigua.
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const { data } = await axios.get('/api/analizar', { params: {
      origen_lat: origin.value[0], origen_lon: origin.value[1],
      destino_lat: destination.value[0], destino_lon: destination.value[1],
    } })
    if (id !== requestId) return
    stopAnimation()
    results.value = data
    analysisVisible.value = true
    activeAlgorithm.value = 'astar'
    await nextTick()
    map.fitBounds([data.origen_ajustado, data.destino_ajustado], { padding: [80, 80], maxZoom: 15 })
    playComparison()
  } catch (err) {
    if (id !== requestId) return
    error.value = typeof err.response?.data?.detail === 'string' ? err.response.data.detail : 'No se pudo conectar con el backend. Comprueba que FastAPI esté en ejecución.'
  } finally {
    if (id === requestId) loading.value = false
  }
}

async function loadMapInfo() {
  try {
    const { data } = await axios.get('/api/mapa', { timeout: 12000 })
    mapInfo.value = data
    if (data.zona_geojson && !boundaryLoaded) {
      map.removeLayer(areaLayer)
      areaLayer = L.geoJSON(data.zona_geojson, { style: { color: '#62d9bf', weight: 2, opacity: 0.85, fillColor: '#62d9bf', fillOpacity: 0.05, dashArray: '7 6', interactive: false } }).addTo(map)
      boundaryLoaded = true
    }
  } catch {
    mapInfo.value = { disponible: false, mensaje: 'No se pudo conectar con FastAPI en el puerto 8000.' }
  }
  if (!mapInfo.value.disponible) backendRetryTimer = setTimeout(loadMapInfo, 5000)
}

onMounted(() => {
  desktopMediaQuery.addEventListener('change', updateDesktopLayout)
  map = L.map(mapElement.value, { zoomControl: false, scrollWheelZoom: true }).setView(center, 11)
  L.control.zoom({ position: 'bottomright' }).addTo(map)
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(map)
  areaLayer = L.rectangle(defaultBounds, { color: '#62d9bf', weight: 1.5, opacity: 0.8, fillColor: '#62d9bf', fillOpacity: 0.055, dashArray: '7 6', interactive: false }).addTo(map)
  explorationCanvas = new ExplorationCanvas().addTo(map)
  explorationLayer = L.layerGroup().addTo(map)
  routeLayer = L.layerGroup().addTo(map)
  markerLayer = L.layerGroup().addTo(map)
  drawMarkers()
  map.on('click', event => choosePoint([event.latlng.lat, event.latlng.lng]))
  let initialFit = false
  resizeObserver = new ResizeObserver(() => {
    map.invalidateSize()
    if (!initialFit && mapElement.value.clientWidth && mapElement.value.clientHeight) {
      map.fitBounds(defaultBounds, { padding: [20, 20] })
      initialFit = true
    }
  })
  resizeObserver.observe(mapElement.value)
  loadMapInfo()
})
onUnmounted(() => {
  stopAnimation()
  clearTimeout(backendRetryTimer)
  desktopMediaQuery.removeEventListener('change', updateDesktopLayout)
  resizeObserver?.disconnect()
  map?.remove()
})
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" :class="{ 'is-collapsed': sidebarIsCollapsed }" aria-label="Controles de rutas">
      <div class="brand"><div class="brand-mark"><span>⌁</span></div><div><strong>ruta<span>lab</span></strong><small>LABORATORIO DE GRAFOS</small></div></div>
      <button
        class="sidebar-toggle" type="button" aria-controls="route-controls"
        :aria-expanded="!sidebarIsCollapsed"
        :aria-label="sidebarIsCollapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'"
        :title="sidebarIsCollapsed ? 'Expandir menú lateral' : 'Contraer menú lateral'"
        @click="sidebarCollapsed = !sidebarCollapsed"
      >{{ sidebarIsCollapsed ? '›' : '‹' }}</button>
      <span v-if="sidebarIsCollapsed" class="sidebar-rail-label" aria-hidden="true">CONTROLES · RUTALAB</span>

      <div id="route-controls" class="sidebar-scroll" :inert="sidebarIsCollapsed">
        <div class="sidebar-heading"><span class="eyebrow">EXPERIMENTO / 001</span><h1>La ciudad es<br /><em>un grafo.</em></h1><p>Compara tres algoritmos sobre las calles de Bogotá, partiendo de la Escuela Colombiana de Ingeniería.</p></div>

        <section class="panel setup-panel">
          <div class="panel-title"><span class="section-number">01</span><h2>Configura tu ruta</h2></div>
          <p class="panel-subtitle">La Escuela es el origen inicial. Elige un destino dentro del límite de Bogotá.</p>
          <div class="point-list">
            <button class="point-input" :class="{ selected: selection === 'origin' }" @click="selection = 'origin'"><span class="point-badge origin-badge">A</span><span class="point-text"><small>ORIGEN</small><strong>{{ formatPoint(origin) }}</strong></span><span class="input-crosshair">⌖</span></button>
            <div class="point-connector"><span></span><button class="swap-button" :disabled="!ready" title="Intercambiar origen y destino" aria-label="Intercambiar origen y destino" @click="swapPoints">⇅</button></div>
            <button class="point-input" :class="{ selected: selection === 'destination' }" @click="selection = 'destination'"><span class="point-badge destination-badge">B</span><span class="point-text"><small>DESTINO</small><strong>{{ formatPoint(destination) }}</strong></span><span class="input-crosshair">⌖</span></button>
          </div>
          <div class="setup-actions"><button class="primary-button" :disabled="!ready || loading" @click="analyze"><span>{{ loading ? 'Analizando rutas...' : results ? 'Volver a analizar' : 'Analizar rutas' }}</span><span>{{ loading ? '◌' : '↗' }}</span></button><button class="clear-button" title="Limpiar puntos" aria-label="Limpiar puntos" @click="reset">↺</button></div>
          <p v-if="error" class="error-message" role="alert">{{ error }}</p>
        </section>

        <section class="algorithm-section"><div class="panel-title"><span class="section-number">02</span><h2>Los algoritmos</h2></div><p class="panel-subtitle">Selecciona uno para ver su trazado y explicación.</p>
          <div class="algorithm-list"><button v-for="item in definitions" :key="item.key" class="algorithm-card" :class="{ active: activeAlgorithm === item.key }" :style="{ '--algorithm-color': item.color }" @click="selectAlgorithm(item.key)"><span class="algorithm-icon">{{ item.icon }}</span><span class="algorithm-info"><small>{{ item.type }}</small><strong>{{ item.name }}</strong></span><span class="algorithm-right"><span v-if="results" class="algorithm-time">{{ results.algoritmos[item.key].rendimiento_ms.toFixed(4) }} <small>ms</small></span><span v-else class="algorithm-index">{{ item.number }}</span></span></button></div>
        </section>

        <div class="sidebar-bottom" :title="mapInfo?.mensaje || ''"><span class="status-dot" :class="{ offline: mapInfo && !mapInfo.disponible && !mapInfo.cargando }"></span><span>{{ !mapInfo ? 'Conectando con el servidor…' : mapInfo.disponible ? `Red OSM lista · ${mapInfo.nodos.toLocaleString('es-ES')} nodos` : mapInfo.cargando ? 'Descargando red vial de Bogotá…' : 'Red OSM no disponible · reintentando' }}</span><span class="version">v1.0</span></div>
      </div>
    </aside>

    <main class="workspace">
      <header class="topbar topbar-lab">
        <div class="topbar-title"><span class="eyebrow mint-text">// VISUALIZACIÓN INTERACTIVA</span><h2>Explora el camino <span>óptimo.</span></h2><p>Observa las ramas del grafo y la ruta elegida sobre Bogotá.</p></div>
        <div class="topbar-actions"><span class="live-dot"></span><span class="osm-label">DATOS DE OPENSTREETMAP</span><div class="area-chip topbar-area"><span class="chip-icon">▧</span><span><small>ÁREA DE ESTUDIO</small><strong>~{{ mapInfo?.metadata?.area_analizada_km2 ?? 394 }} km² <span>· Bogotá</span></strong></span></div><button v-if="results" class="analysis-toggle" :aria-pressed="analysisVisible" @click="analysisVisible = !analysisVisible">{{ analysisVisible ? '▣ Ocultar análisis' : '▤ Mostrar análisis' }}</button></div>
      </header>

      <div class="content">
        <div class="map-card">
          <div ref="mapElement" class="map-canvas" aria-label="Mapa interactivo de Bogotá para seleccionar origen y destino"></div>
          <div class="map-top-left"><span class="map-label"><span class="label-dot"></span> RED VIAL · BOGOTÁ</span></div>
          <div class="map-top-right"><span class="map-instruction">{{ !destination ? '① Origen: Escuela Colombiana · elige destino' : `Editando ${selection === 'origin' ? 'origen' : 'destino'} · haz clic en el mapa` }}</span></div>
          <button v-if="ready && !results && !loading" class="map-quick-analyze" @click="analyze">Analizar desde A hasta B ↗</button>
          <div v-if="results" class="map-animation-control">
            <div class="animation-heading"><span class="animation-dot" :style="{ background: selectedResult.color_sugerido }"></span><strong>{{ selectedResult.nombre }}</strong><span>{{ animationProgress }}%</span></div>
            <div class="animation-phase">{{ animationPhase === 'exploracion' ? 'Explorando el grafo vial' : 'Trazando la ruta óptima' }}<span v-if="activeAlgorithm === 'bidireccional' && animationPhase === 'exploracion'" class="reverse-legend">● destino</span></div>
            <div class="explored-counter">{{ currentExplored.toLocaleString('es-ES') }} / {{ selectedResult.nodos_explorados.toLocaleString('es-ES') }} nodos expandidos</div>
            <div class="animation-track"><div :style="{ width: `${animationProgress}%`, background: selectedResult.color_sugerido }"></div></div>
            <button @click="playComparison">{{ comparePlaying ? '↻ Reiniciar comparación' : animationPlaying ? '▶ Animar las tres rutas' : '▶ Reproducir comparación' }}</button>
            <button class="branches-toggle" :aria-pressed="branchesVisible" @click="toggleBranches">{{ branchesVisible ? '◉ Ocultar ramas' : '◎ Mostrar todas las ramas' }}</button>
          </div>
          <div class="map-bottom-left"><span class="bounds-icon">⬡</span> COBERTURA · CIUDAD DE BOGOTÁ</div>
          <div v-if="loading" class="map-loading"><div class="loader"></div><span>Calculando tres rutas sobre el grafo vial…</span></div>
          <AnalysisWindows
            v-if="results" :algorithms="results.algoritmos" :definitions="definitions"
            :active-algorithm="activeAlgorithm" :fastest="fastest"
            :map-element="mapElement" :visible="analysisVisible"
          />
        </div>
        <footer class="workspace-footer"><span>↳ Todas las ramas del árbol de búsqueda se dibujan entre cruces; la ruta elegida sigue la geometría real de las calles. «Mejor» = menor tiempo de búsqueda, no de viaje.</span><span>HECHO PARA APRENDER, NO PARA NAVEGAR ↗</span></footer>
      </div>
    </main>
  </div>
</template>

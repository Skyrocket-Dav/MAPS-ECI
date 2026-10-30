<script setup>
import { computed, toRef } from 'vue'
import { Bar } from 'vue-chartjs'
import { Chart as ChartJS, BarElement, CategoryScale, LinearScale, Tooltip } from 'chart.js'
import { useFloatingPanels } from './useFloatingPanels.js'

ChartJS.register(BarElement, CategoryScale, LinearScale, Tooltip)

const props = defineProps({
  algorithms: { type: Object, required: true },
  definitions: { type: Array, required: true },
  activeAlgorithm: { type: String, required: true },
  fastest: { type: String, required: true },
  mapElement: { type: Object, required: true },
  visible: { type: Boolean, required: true },
})

const selectedResult = computed(() => props.algorithms[props.activeAlgorithm])
const chartData = computed(() => ({
  labels: props.definitions.map(item => item.name),
  datasets: [{
    data: props.definitions.map(item => props.algorithms[item.key].rendimiento_ms),
    backgroundColor: props.definitions.map(item => item.color),
    borderRadius: 5,
    barThickness: 13,
  }],
}))
const chartOptions = {
  indexAxis: 'y', responsive: true, maintainAspectRatio: false,
  animation: { duration: 500 },
  plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => ` ${context.parsed.x.toFixed(4)} ms` } } },
  scales: {
    x: { beginAtZero: true, grid: { color: '#26364a' }, border: { display: false }, ticks: { color: '#8897a9', font: { family: 'DM Sans' }, callback: value => `${value} ms` } },
    y: { grid: { display: false }, border: { display: false }, ticks: { color: '#dce7f2', font: { family: 'DM Sans', weight: '600', size: 12 } } },
  },
}
const { minimized, offsets, performancePanel, insightPanel, startDrag, moveDrag, endDrag, nudge, toggle } = useFloatingPanels(props.mapElement, toRef(props, 'visible'))
</script>

<template>
  <template v-if="visible">
    <section
      ref="performancePanel" class="floating-panel floating-performance"
      :class="{ minimized: minimized.performance }"
      :style="{ transform: `translate(${offsets.performance.x}px, ${offsets.performance.y}px)` }"
      aria-label="Análisis del tiempo de búsqueda" @click.stop @pointerdown.stop @wheel.stop
    >
      <div class="floating-header" tabindex="0" aria-label="Mover ventana de tiempos con arrastre o flechas"
        @pointerdown="startDrag($event, 'performance')" @pointermove="moveDrag" @pointerup="endDrag"
        @pointercancel="endDrag" @keydown="nudge($event, 'performance')">
        <span class="drag-handle">⠿</span>
        <div><small>ANÁLISIS / 01</small><strong>Tiempo de búsqueda</strong></div>
        <button class="minimize-button" :aria-label="minimized.performance ? 'Expandir tiempos' : 'Minimizar tiempos'"
          @pointerdown.stop @click="toggle('performance')">{{ minimized.performance ? '+' : '−' }}</button>
      </div>
      <div v-if="!minimized.performance" class="floating-body">
        <div class="chart-wrap"><Bar :data="chartData" :options="chartOptions" /></div>
        <div class="chart-footer"><span>Menor tiempo = búsqueda más rápida</span><span>ms</span></div>
      </div>
    </section>

    <section
      ref="insightPanel" class="floating-panel floating-insight"
      :class="{ minimized: minimized.insight }"
      :style="{ transform: `translate(${offsets.insight.x}px, ${offsets.insight.y}px)` }"
      aria-label="Análisis del algoritmo seleccionado" @click.stop @pointerdown.stop @wheel.stop
    >
      <div class="floating-header" tabindex="0" aria-label="Mover ventana de explicación con arrastre o flechas"
        @pointerdown="startDrag($event, 'insight')" @pointermove="moveDrag" @pointerup="endDrag"
        @pointercancel="endDrag" @keydown="nudge($event, 'insight')">
        <span class="drag-handle">⠿</span>
        <div><small>ANÁLISIS / 02</small><strong>Dentro del algoritmo</strong></div>
        <button class="minimize-button" :aria-label="minimized.insight ? 'Expandir explicación' : 'Minimizar explicación'"
          @pointerdown.stop @click="toggle('insight')">{{ minimized.insight ? '+' : '−' }}</button>
      </div>
      <div v-if="!minimized.insight" class="floating-body">
        <div class="insight-title">
          <span class="insight-color" :style="{ background: selectedResult.color_sugerido }"></span>
          <strong>{{ selectedResult.nombre }}</strong>
          <span v-if="fastest === activeAlgorithm" class="fastest-tag">MÁS RÁPIDO</span>
        </div>
        <p class="insight-description">{{ selectedResult.didactica.funcionamiento }}</p>
        <div class="insight-metrics">
          <div><small>DISTANCIA</small><strong>{{ (selectedResult.distancia_m / 1000).toFixed(2) }} <span>km</span></strong></div>
          <div><small>EN RUTA</small><strong>{{ selectedResult.nodos_en_camino }}</strong></div>
          <div><small>EXPLORADOS</small><strong>{{ selectedResult.nodos_explorados.toLocaleString('es-ES') }}</strong></div>
          <div><small>BÚSQUEDA</small><strong>{{ selectedResult.rendimiento_ms.toFixed(4) }} <span>ms</span></strong></div>
        </div>
        <p class="insight-note">{{ selectedResult.didactica.analisis_estudiante }}<span class="use-case">Aplicación: {{ selectedResult.didactica.caso_de_uso }}</span></p>
      </div>
    </section>
  </template>
</template>

import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

// Mueve las ventanas dentro del mapa sin modificar las interacciones de Leaflet.
export function useFloatingPanels(mapElement, visible) {
  const mapMargin = 8
  const keyboardStep = 15
  const initiallyMinimized = window.innerWidth <= 620
  const minimized = ref({ performance: initiallyMinimized, insight: initiallyMinimized })
  const offsets = ref({ performance: { x: 0, y: 0 }, insight: { x: 0, y: 0 } })
  const performancePanel = ref(null)
  const insightPanel = ref(null)
  let drag = null
  let observer

  function panelFor(key) {
    return key === 'performance' ? performancePanel.value : insightPanel.value
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, value))
  }

  function keepInside(key) {
    const panel = panelFor(key)
    if (!panel || !mapElement) return
    const bounds = mapElement.getBoundingClientRect()
    const rect = panel.getBoundingClientRect()
    // Si cambia el tamaño del mapa o de la ventana, corregimos solo el desbordamiento.
    const dx = clamp(0, bounds.left + mapMargin - rect.left, bounds.right - mapMargin - rect.right)
    const dy = clamp(0, bounds.top + mapMargin - rect.top, bounds.bottom - mapMargin - rect.bottom)
    if (dx || dy) offsets.value[key] = { x: offsets.value[key].x + dx, y: offsets.value[key].y + dy }
  }

  function keepBothInside() {
    keepInside('performance')
    keepInside('insight')
  }

  function startDrag(event, key) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    drag = {
      key, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      offset: { ...offsets.value[key] },
      rect: panelFor(key).getBoundingClientRect(), bounds: mapElement.getBoundingClientRect(),
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveDrag(event) {
    if (!drag || event.pointerId !== drag.pointerId) return
    const { key, x, y, offset, rect, bounds } = drag
    const dx = clamp(event.clientX - x, bounds.left + mapMargin - rect.left, bounds.right - mapMargin - rect.right)
    const dy = clamp(event.clientY - y, bounds.top + mapMargin - rect.top, bounds.bottom - mapMargin - rect.bottom)
    offsets.value[key] = { x: offset.x + dx, y: offset.y + dy }
  }

  function endDrag(event) {
    if (drag?.pointerId === event.pointerId) drag = null
  }

  function nudge(event, key) {
    const delta = {
      ArrowLeft: [-keyboardStep, 0], ArrowRight: [keyboardStep, 0],
      ArrowUp: [0, -keyboardStep], ArrowDown: [0, keyboardStep],
    }[event.key]
    if (!delta) return
    event.preventDefault()
    offsets.value[key] = { x: offsets.value[key].x + delta[0], y: offsets.value[key].y + delta[1] }
    nextTick(() => keepInside(key))
  }

  function toggle(key) {
    minimized.value[key] = !minimized.value[key]
    if (window.innerWidth <= 620 && !minimized.value[key]) {
      minimized.value[key === 'performance' ? 'insight' : 'performance'] = true
    }
    nextTick(() => keepInside(key))
  }

  watch(visible, () => nextTick(keepBothInside))
  onMounted(() => {
    observer = new ResizeObserver(keepBothInside)
    observer.observe(mapElement)
    window.addEventListener('resize', keepBothInside)
  })
  onUnmounted(() => {
    observer?.disconnect()
    window.removeEventListener('resize', keepBothInside)
  })

  return { minimized, offsets, performancePanel, insightPanel, startDrag, moveDrag, endDrag, nudge, toggle }
}

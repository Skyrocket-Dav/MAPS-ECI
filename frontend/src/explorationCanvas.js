import L from 'leaflet'

// A single incremental canvas for every branch of the actual search tree.
// Leaflet polylines for tens of thousands of edges would create too many
// shapes and repeatedly redraw all old branches on every animation frame.
export class ExplorationCanvas extends L.Layer {
  onAdd(map) {
    this.map = map
    this.canvas = L.DomUtil.create('canvas', 'exploration-canvas', map.getPanes().overlayPane)
    this.canvas.style.pointerEvents = 'none'
    this.ctx = this.canvas.getContext('2d')
    map.on('moveend zoomend resize', this.reset, this)
    this.reset()
  }

  onRemove(map) {
    map.off('moveend zoomend resize', this.reset, this)
    L.DomUtil.remove(this.canvas)
    this.canvas = null
    this.map = null
  }

  setTree(tree, color) {
    this.tree = tree
    this.color = color
    this.visibleCount = 0
    this.reset()
  }

  setDimmed(dimmed) {
    if (this.canvas) this.canvas.style.opacity = dimmed ? '0.52' : '1'
  }

  setVisible(visible) {
    if (this.canvas) this.canvas.style.visibility = visible ? 'visible' : 'hidden'
  }

  reset() {
    if (!this.map || !this.canvas) return
    const size = this.map.getSize()
    const scale = window.devicePixelRatio || 1
    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]))
    this.canvas.width = Math.round(size.x * scale)
    this.canvas.height = Math.round(size.y * scale)
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    this.ctx.setTransform(scale, 0, 0, scale, 0, 0)
    this.points = this.tree?.nodos.map(([lat, lon]) => this.map.latLngToContainerPoint([lat, lon])) ?? []
    const count = this.visibleCount ?? 0
    this.drawnCount = 0
    this.drawTo(count)
  }

  drawTo(count) {
    if (!this.canvas || !this.tree) return
    const target = Math.min(Math.max(0, count), this.tree.aristas.length)
    if (target < this.drawnCount) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
      this.drawnCount = 0
    }
    // Paint only the NEW edges. The previous branches remain on the canvas.
    for (const side of [0, 1]) {
      this.ctx.beginPath()
      for (let i = this.drawnCount; i < target; i++) {
        const [a, b, edgeSide] = this.tree.aristas[i]
        if (edgeSide !== side) continue
        const from = this.points[a], to = this.points[b]
        this.ctx.moveTo(from.x, from.y)
        this.ctx.lineTo(to.x, to.y)
      }
      this.ctx.lineCap = 'round'
      this.ctx.lineWidth = 4.5
      this.ctx.strokeStyle = '#1b3442'
      this.ctx.globalAlpha = 0.6
      this.ctx.stroke()
      this.ctx.lineWidth = 2.5
      this.ctx.strokeStyle = side === 0 ? this.color : '#6fa7ff'
      this.ctx.globalAlpha = 0.95
      this.ctx.stroke()
    }
    this.ctx.globalAlpha = 1
    this.drawnCount = target
    this.visibleCount = target
  }
}

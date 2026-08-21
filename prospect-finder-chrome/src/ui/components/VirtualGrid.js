/**
 * VirtualGrid.js — Windowed renderer with node recycling.
 *
 * v1 called `el.grid.innerHTML = ''` then rebuilt every card on each 3s poll.
 * That destroyed scroll position, checkbox focus and open <details> panels,
 * and janked hard past a few hundred rows.
 *
 * Here the DOM node count is bounded by the viewport (~20 nodes) no matter
 * how many rows exist, and updates PATCH existing nodes instead of replacing
 * them, so interaction state survives live data changes.
 */

export class VirtualGrid {
  /**
   * @param {object} o
   * @param {HTMLElement} o.scroller  scrolling container
   * @param {HTMLElement} o.spacer    height-holding element
   * @param {HTMLElement} o.window    absolutely-positioned row container
   * @param {(item:any)=>HTMLElement} o.create
   * @param {(node:HTMLElement,item:any)=>void} o.patch
   * @param {(item:any)=>string} o.keyOf
   */
  constructor({ scroller, spacer, window: win, create, patch, keyOf, itemHeight = 172, gap = 10, overscan = 5, columns = 1 }) {
    this.scroller = scroller;
    this.spacer = spacer;
    this.win = win;
    this.create = create;
    this.patch = patch;
    this.keyOf = keyOf;
    this.itemHeight = itemHeight;
    this.gap = gap;
    this.overscan = overscan;
    this.columns = columns;

    this.items = [];
    this.nodes = new Map();   // key -> element (currently mounted)
    this.pool = [];           // detached elements available for reuse
    this._raf = 0;
    this._range = [-1, -1];

    this._onScroll = () => this.schedule();
    this.scroller.addEventListener('scroll', this._onScroll, { passive: true });

    this._ro = new ResizeObserver(() => this.measure());
    this._ro.observe(this.scroller);
  }

  get rowHeight() { return this.itemHeight + this.gap; }

  measure() {
    const w = this.scroller.clientWidth - 32;
    const min = 330;
    const cols = Math.max(1, Math.min(4, Math.floor(w / min)));
    if (cols !== this.columns) {
      this.columns = cols;
      this.win.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
      this._range = [-1, -1];
    }
    this.render(true);
  }

  setItems(items) {
    this.items = items || [];
    const rows = Math.ceil(this.items.length / this.columns);
    this.spacer.style.height = `${Math.max(0, rows * this.rowHeight - this.gap + 24)}px`;
    if (this.scroller.scrollTop > this.spacer.clientHeight) this.scroller.scrollTop = 0;
    this._range = [-1, -1];
    this.render(true);
  }

  /** Patch rows in place without touching the mount set. */
  updateItems(items) {
    this.items = items || [];
    for (const [key, node] of this.nodes) {
      const item = this.items.find(i => this.keyOf(i) === key);
      if (item) this.patch(node, item);
    }
  }

  schedule() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render(false);
    });
  }

  render(force) {
    const top = this.scroller.scrollTop;
    const h = this.scroller.clientHeight;
    const rh = this.rowHeight;

    const firstRow = Math.max(0, Math.floor(top / rh) - this.overscan);
    const lastRow = Math.ceil((top + h) / rh) + this.overscan;

    const start = firstRow * this.columns;
    const end = Math.min(this.items.length, lastRow * this.columns);

    if (!force && start === this._range[0] && end === this._range[1]) return;
    this._range = [start, end];

    this.win.style.transform = `translateY(${firstRow * rh}px)`;

    const needed = new Set();
    for (let i = start; i < end; i++) {
      const item = this.items[i];
      if (!item) continue;
      needed.add(this.keyOf(item));
    }

    // Recycle nodes that scrolled out of view.
    for (const [key, node] of [...this.nodes]) {
      if (!needed.has(key)) {
        node.remove();
        this.nodes.delete(key);
        if (this.pool.length < 60) this.pool.push(node);
      }
    }

    // Mount / patch the visible window in order.
    const frag = document.createDocumentFragment();
    let appended = false;
    for (let i = start; i < end; i++) {
      const item = this.items[i];
      if (!item) continue;
      const key = this.keyOf(item);
      let node = this.nodes.get(key);
      if (node) {
        this.patch(node, item);
      } else {
        node = this.pool.pop();
        if (node) {
          this.patch(node, item);
        } else {
          node = this.create(item);
        }
        node.dataset.key = key;
        this.nodes.set(key, node);
        frag.appendChild(node);
        appended = true;
      }
    }
    if (appended) this.win.appendChild(frag);

    // Keep DOM order matching data order (cheap: only when misordered).
    const kids = this.win.children;
    let idx = 0;
    for (let i = start; i < end; i++) {
      const item = this.items[i];
      if (!item) continue;
      const node = this.nodes.get(this.keyOf(item));
      if (kids[idx] !== node) this.win.insertBefore(node, kids[idx] || null);
      idx++;
    }
  }

  scrollToTop() { this.scroller.scrollTop = 0; }

  destroy() {
    this.scroller.removeEventListener('scroll', this._onScroll);
    this._ro.disconnect();
    if (this._raf) cancelAnimationFrame(this._raf);
    this.nodes.clear();
    this.pool.length = 0;
  }
}

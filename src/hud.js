// HUD — all in-game 2D presentation: item slot, lap, timer, position, speedometer,
// minimap, countdown, lap messages, wrong-way banner, title menu, results, loading.
// Everything is built as DOM inside #hud / #menu / #results (index.html provides them);
// styling lives in styles.css. update() is cheap: last values are cached and the DOM
// is only touched when something actually changed.

import { ITEM_LABELS, TOTAL_LAPS, NUM_RACERS } from './constants.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

// Speedometer geometry (viewBox 0 0 200 200): 270° arc from 135° to 405°.
const GAUGE_R = 78;
const GAUGE_START_DEG = 135;
const GAUGE_SWEEP_DEG = 270;
const GAUGE_LEN = 2 * Math.PI * GAUGE_R * (GAUGE_SWEEP_DEG / 360);

const MINIMAP_SIZE = 180;   // CSS px (canvas backing store is 2x)
const MINIMAP_PAD = 16;
const MINIMAP_HZ = 30;      // redraw throttle

const ORDINALS = ['th', 'st', 'nd', 'rd'];

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  return ORDINALS[n % 10] || 'th';
}

function hexColor(c) {
  if (typeof c === 'string') return c;
  if (typeof c === 'number') return '#' + (c >>> 0).toString(16).padStart(6, '0').slice(-6);
  return '#ffffff';
}

function formatTime(t) {
  if (t == null || typeof t !== 'number' || !isFinite(t)) return '—';
  const total = Math.max(0, t);
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  const cs = Math.floor((total * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function el(tag, className, parent, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}

function svgEl(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function polar(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

// ---------------------------------------------------------------------------
// Procedural item icons (drawn once onto small canvases)
// ---------------------------------------------------------------------------

function drawMushroom(ctx, cx, cy, r, capColor) {
  // stem
  ctx.fillStyle = '#fff3d6';
  ctx.strokeStyle = '#3a2a1a';
  ctx.lineWidth = r * 0.12;
  ctx.beginPath();
  ctx.roundRect
    ? ctx.roundRect(cx - r * 0.45, cy - r * 0.05, r * 0.9, r * 0.95, r * 0.25)
    : ctx.rect(cx - r * 0.45, cy - r * 0.05, r * 0.9, r * 0.95);
  ctx.fill();
  ctx.stroke();
  // eyes
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.2, cy + r * 0.4, r * 0.07, r * 0.16, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + r * 0.2, cy + r * 0.4, r * 0.07, r * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
  // cap
  ctx.fillStyle = capColor;
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0);
  ctx.quadraticCurveTo(cx + r, cy + r * 0.25, cx + r * 0.8, cy + r * 0.25);
  ctx.lineTo(cx - r * 0.8, cy + r * 0.25);
  ctx.quadraticCurveTo(cx - r, cy + r * 0.25, cx - r, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // dots
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(cx, cy - r * 0.55, r * 0.22, 0, Math.PI * 2);
  ctx.arc(cx - r * 0.58, cy - r * 0.1, r * 0.17, 0, Math.PI * 2);
  ctx.arc(cx + r * 0.58, cy - r * 0.1, r * 0.17, 0, Math.PI * 2);
  ctx.fill();
}

function drawShell(ctx, cx, cy, r, color, dark) {
  ctx.lineWidth = r * 0.1;
  ctx.strokeStyle = '#222';
  // base rim (white) with spikes
  ctx.fillStyle = '#fffbe6';
  ctx.beginPath();
  ctx.ellipse(cx, cy + r * 0.35, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // dome
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy + r * 0.2, r, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // spikes / plates
  ctx.fillStyle = dark;
  for (let i = 0; i < 3; i++) {
    const a = Math.PI + (Math.PI * (i + 1)) / 4;
    const [px, py] = polar(cx, cy + r * 0.2, r * 0.62, (a * 180) / Math.PI);
    ctx.beginPath();
    ctx.arc(px, py, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
  }
  // shine
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.4, cy - r * 0.35, r * 0.22, r * 0.12, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawStar(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#3a2a00';
  ctx.lineWidth = r * 0.1;
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const [x, y] = polar(cx, cy, rad, -90 + i * 36);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // eyes
  ctx.fillStyle = '#222';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.18, cy + r * 0.05, r * 0.07, r * 0.16, 0, 0, Math.PI * 2);
  ctx.ellipse(cx + r * 0.18, cy + r * 0.05, r * 0.07, r * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();
}

const ICON_PAINTERS = {
  mushroom(ctx, s) { drawMushroom(ctx, s / 2, s * 0.42, s * 0.36, '#e53935'); },
  triple_mushroom(ctx, s) {
    drawMushroom(ctx, s * 0.3, s * 0.62, s * 0.2, '#e53935');
    drawMushroom(ctx, s * 0.7, s * 0.62, s * 0.2, '#e53935');
    drawMushroom(ctx, s * 0.5, s * 0.34, s * 0.22, '#e53935');
  },
  banana(ctx, s) {
    ctx.lineCap = 'round';
    ctx.lineWidth = s * 0.2;
    ctx.strokeStyle = '#3a2a00';
    ctx.beginPath();
    ctx.moveTo(s * 0.25, s * 0.28);
    ctx.quadraticCurveTo(s * 0.35, s * 0.85, s * 0.8, s * 0.62);
    ctx.stroke();
    ctx.lineWidth = s * 0.14;
    ctx.strokeStyle = '#ffe14d';
    ctx.stroke();
    // tips
    ctx.fillStyle = '#6d4c1c';
    ctx.beginPath();
    ctx.arc(s * 0.25, s * 0.28, s * 0.06, 0, Math.PI * 2);
    ctx.arc(s * 0.8, s * 0.62, s * 0.05, 0, Math.PI * 2);
    ctx.fill();
    // stem
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(s * 0.19, s * 0.15, s * 0.1, s * 0.14);
  },
  green_shell(ctx, s) { drawShell(ctx, s / 2, s * 0.42, s * 0.36, '#43a047', '#1b5e20'); },
  red_shell(ctx, s) { drawShell(ctx, s / 2, s * 0.42, s * 0.36, '#e53935', '#8e0000'); },
  star(ctx, s) { drawStar(ctx, s / 2, s * 0.52, s * 0.44, '#ffd54f'); },
  lightning(ctx, s) {
    ctx.fillStyle = '#ffee58';
    ctx.strokeStyle = '#7a5a00';
    ctx.lineWidth = s * 0.05;
    ctx.beginPath();
    ctx.moveTo(s * 0.58, s * 0.06);
    ctx.lineTo(s * 0.26, s * 0.54);
    ctx.lineTo(s * 0.48, s * 0.54);
    ctx.lineTo(s * 0.38, s * 0.94);
    ctx.lineTo(s * 0.76, s * 0.42);
    ctx.lineTo(s * 0.54, s * 0.42);
    ctx.lineTo(s * 0.68, s * 0.06);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  },
  bomb(ctx, s) {
    // fuse
    ctx.strokeStyle = '#8d6e63';
    ctx.lineWidth = s * 0.05;
    ctx.beginPath();
    ctx.moveTo(s * 0.55, s * 0.32);
    ctx.quadraticCurveTo(s * 0.62, s * 0.12, s * 0.8, s * 0.16);
    ctx.stroke();
    // spark
    ctx.fillStyle = '#ffab00';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const rad = i % 2 === 0 ? s * 0.09 : s * 0.04;
      const [x, y] = polar(s * 0.82, s * 0.15, rad, i * 45);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    // body
    ctx.fillStyle = '#212121';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = s * 0.04;
    ctx.beginPath();
    ctx.arc(s * 0.48, s * 0.6, s * 0.32, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // cap
    ctx.fillStyle = '#616161';
    ctx.fillRect(s * 0.42, s * 0.24, s * 0.14, s * 0.1);
    // shine + eyes
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.beginPath();
    ctx.ellipse(s * 0.36, s * 0.48, s * 0.08, s * 0.05, -0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.ellipse(s * 0.42, s * 0.62, s * 0.035, s * 0.08, 0, 0, Math.PI * 2);
    ctx.ellipse(s * 0.56, s * 0.62, s * 0.035, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
  },
};

function buildItemIcons() {
  const icons = {};
  const size = 96;
  for (const name in ICON_PAINTERS) {
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    c.className = 'item-icon';
    const ctx = c.getContext && c.getContext('2d');
    if (ctx) {
      ctx.lineJoin = 'round';
      try { ICON_PAINTERS[name](ctx, size); } catch (e) { /* never break the HUD over an icon */ }
    }
    icons[name] = c;
  }
  return icons;
}

// ---------------------------------------------------------------------------

export class HUD {
  constructor() {
    this.root = document.getElementById('hud');
    this.menuEl = document.getElementById('menu');
    this.resultsEl = document.getElementById('results');
    this.overlayEl = document.getElementById('overlay');
    this.loadingEl = document.getElementById('loading');

    // Fallbacks so the HUD never throws if index.html changed.
    if (!this.root) this.root = el('div', null, document.body);
    if (!this.menuEl) this.menuEl = el('div', null, document.body);
    if (!this.resultsEl) this.resultsEl = el('div', null, document.body);
    if (!this.overlayEl) this.overlayEl = el('div', null, document.body);

    this.icons = buildItemIcons();
    this._last = {
      speedKmh: -1, speedRatio: -1, lap: -1, totalLaps: -1, position: -1, totalRacers: -1,
      item: undefined, itemCount: -1, rouletteItem: undefined, driftTier: -1,
      timeStr: '', wrongWay: null, boosting: null, fps: -1,
    };
    this._lapMsgTimer = 0;
    this._startCallbacks = [];
    this._startWired = false;
    this._minimap = { points: null, cache: null, bounds: null, lastDraw: 0 };

    this._buildHud();
    this._buildMenu();
    this._buildResults();
  }

  // ------------------------------------------------------------------ build

  _buildHud() {
    const root = this.root;
    root.innerHTML = '';

    // Item slot (top-left)
    const item = el('div', 'hud-item', root);
    this.itemCircle = el('div', 'item-circle', item);
    this.itemIconHolder = el('div', 'item-icon-holder', this.itemCircle);
    this.itemCount = el('div', 'item-count hidden', this.itemCircle, '');
    this.itemLabel = el('div', 'item-label', item, '');

    // Timer (top-centre)
    this.timer = el('div', 'hud-timer pill', root, '00:00.00');

    // Wrong-way banner
    this.wrongWay = el('div', 'hud-wrongway hidden', root, 'WRONG WAY!');

    // Lap (top-right)
    this.lap = el('div', 'hud-lap pill', root);
    el('span', 'lap-word', this.lap, 'LAP');
    this.lapValue = el('span', 'lap-value', this.lap, `1/${TOTAL_LAPS}`);

    // Position (bottom-left)
    this.position = el('div', 'hud-position pn', root);
    this.posNumber = el('span', 'pos-number', this.position, '8');
    this.posOrdinal = el('span', 'pos-ordinal', this.position, 'th');

    // FPS
    this.fps = el('div', 'hud-fps', root, '');

    // Speedometer (bottom-right)
    this.speedo = el('div', 'hud-speedo', root);
    this.driftRing = el('div', 'drift-ring', this.speedo);
    const svg = svgEl('svg', { viewBox: '0 0 200 200' }, this.speedo);
    const defs = svgEl('defs', {}, svg);
    const grad = svgEl('linearGradient', { id: 'speedoGrad', x1: '0', y1: '1', x2: '1', y2: '0' }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': '#40c4ff' }, grad);
    svgEl('stop', { offset: '55%', 'stop-color': '#ffee58' }, grad);
    svgEl('stop', { offset: '100%', 'stop-color': '#ff7043' }, grad);
    const gradB = svgEl('linearGradient', { id: 'speedoGradBoost', x1: '0', y1: '1', x2: '1', y2: '0' }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': '#ffab40' }, gradB);
    svgEl('stop', { offset: '100%', 'stop-color': '#ff1744' }, gradB);

    const [sx, sy] = polar(100, 100, GAUGE_R, GAUGE_START_DEG);
    const [ex, ey] = polar(100, 100, GAUGE_R, GAUGE_START_DEG + GAUGE_SWEEP_DEG);
    const d = `M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${GAUGE_R} ${GAUGE_R} 0 1 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`;
    svgEl('path', { d, class: 'speedo-track' }, svg);
    this.speedoArc = svgEl('path', {
      d, class: 'speedo-arc',
      'stroke-dasharray': GAUGE_LEN.toFixed(2),
      'stroke-dashoffset': GAUGE_LEN.toFixed(2),
    }, svg);
    // ticks
    const ticks = svgEl('g', { class: 'speedo-ticks' }, svg);
    for (let i = 0; i <= 10; i++) {
      const a = GAUGE_START_DEG + (GAUGE_SWEEP_DEG * i) / 10;
      const major = i % 5 === 0;
      const [x1, y1] = polar(100, 100, GAUGE_R - 12, a);
      const [x2, y2] = polar(100, 100, GAUGE_R - (major ? 22 : 17), a);
      svgEl('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1) }, ticks);
    }
    this.speedoNeedle = svgEl('line', {
      x1: 100, y1: 100, x2: 100, y2: 40, class: 'speedo-needle',
      transform: `rotate(${GAUGE_START_DEG - 270} 100 100)`,
    }, svg);
    svgEl('circle', { cx: 100, cy: 100, r: 7, class: 'speedo-hub' }, svg);

    const readout = el('div', 'speed-readout', this.speedo);
    this.speedValue = el('span', 'speed-value', readout, '0');
    el('span', 'speed-unit', readout, 'KM/H');

    // Minimap (right-middle)
    const mm = el('div', 'hud-minimap', root);
    this.minimapCanvas = el('canvas', null, mm);
    this.minimapCanvas.width = MINIMAP_SIZE * 2;
    this.minimapCanvas.height = MINIMAP_SIZE * 2;
    this.minimapCtx = this.minimapCanvas.getContext ? this.minimapCanvas.getContext('2d') : null;

    // Countdown + lap message
    this.countdown = el('div', 'hud-countdown', root, '');
    this.lapMsg = el('div', 'hud-lapmsg', root, '');
  }

  _buildMenu() {
    const m = this.menuEl;
    m.innerHTML = '';
    el('div', 'menu-stripes', m);
    const inner = el('div', 'menu-inner', m);
    el('div', 'menu-logo', inner, 'TURBO KART');
    el('div', 'menu-sub', inner, 'GRAND PRIX');
    el('div', 'menu-prompt pill', inner, 'PRESS ENTER OR CLICK TO RACE');
    el('div', 'menu-hint', inner, 'CLICK ANYWHERE TO START • SOUND ON');

    const card = el('div', 'menu-controls', inner);
    el('div', 'ctl-title', card, 'CONTROLS');
    const rows = [
      ['<kbd>W</kbd>/<kbd>↑</kbd>', 'Accelerate'],
      ['<kbd>S</kbd>/<kbd>↓</kbd>', 'Brake / Reverse'],
      ['<kbd>A</kbd> <kbd>D</kbd> / <kbd>←</kbd> <kbd>→</kbd>', 'Steer'],
      ['<kbd>Shift</kbd> / <kbd>Space</kbd>', 'Hop / Drift (hold for mini-turbo)'],
      ['<kbd>Ctrl</kbd> / <kbd>E</kbd> / <kbd>Enter</kbd>', 'Use item'],
      ['<kbd>Q</kbd>', 'Look back'],
      ['<kbd>P</kbd> / <kbd>Esc</kbd>', 'Pause'],
      ['<kbd>R</kbd>', 'Restart race'],
    ];
    for (const [k, desc] of rows) {
      const kEl = el('div', 'ctl-key', card);
      kEl.innerHTML = k;
      el('div', 'ctl-desc', card, desc);
    }
  }

  _buildResults() {
    const r = this.resultsEl;
    r.innerHTML = '';
    const panel = el('div', 'results-panel', r);
    el('h2', 'results-title', panel, 'RACE RESULTS');
    const table = el('table', 'results-table', panel);
    this.resultsBody = el('tbody', null, table);
    el('div', 'results-prompt', panel, 'PRESS ENTER TO RACE AGAIN');
  }

  // ------------------------------------------------------------- minimap

  setMinimapTrack(points) {
    const mm = this._minimap;
    mm.points = Array.isArray(points) && points.length > 1 ? points : null;
    mm.cache = null;
    mm.bounds = null;
    if (!mm.points) return;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of mm.points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const size = MINIMAP_SIZE * 2;
    const pad = MINIMAP_PAD * 2;
    const spanX = Math.max(1e-3, maxX - minX);
    const spanZ = Math.max(1e-3, maxZ - minZ);
    const scale = Math.min((size - pad * 2) / spanX, (size - pad * 2) / spanZ);
    const ox = (size - spanX * scale) / 2 - minX * scale;
    const oz = (size - spanZ * scale) / 2 - minZ * scale;
    mm.bounds = { scale, ox, oz };

    // Pre-render the track polyline once.
    const cache = document.createElement('canvas');
    cache.width = size;
    cache.height = size;
    const ctx = cache.getContext ? cache.getContext('2d') : null;
    if (ctx) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      mm.points.forEach((p, i) => {
        const x = p.x * scale + ox;
        const y = p.z * scale + oz;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 18;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 8;
      ctx.stroke();
      // start line marker
      const p0 = mm.points[0];
      const p1 = mm.points[1];
      const dx = p1.x - p0.x, dz = p1.z - p0.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      ctx.strokeStyle = '#ffd54f';
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo((p0.x - nx * 6) * scale + ox, (p0.z - nz * 6) * scale + oz);
      ctx.lineTo((p0.x + nx * 6) * scale + ox, (p0.z + nz * 6) * scale + oz);
      ctx.stroke();
    }
    mm.cache = cache;
    this._drawMinimap(null, true);
  }

  _drawMinimap(karts, force) {
    const ctx = this.minimapCtx;
    const mm = this._minimap;
    if (!ctx) return;
    const now = performance.now();
    if (!force && now - mm.lastDraw < 1000 / MINIMAP_HZ) return;
    mm.lastDraw = now;

    const size = MINIMAP_SIZE * 2;
    ctx.clearRect(0, 0, size, size);
    if (mm.cache) ctx.drawImage(mm.cache, 0, 0);
    if (!karts || !mm.bounds) return;

    const { scale, ox, oz } = mm.bounds;
    // Draw bots first so the player is on top.
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < karts.length; i++) {
        const k = karts[i];
        if (!k) continue;
        const isPlayer = !!k.isPlayer;
        if ((pass === 0) === isPlayer) continue;
        const x = k.x * scale + ox;
        const y = k.z * scale + oz;
        const r = isPlayer ? 11 : 7;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = hexColor(k.color);
        ctx.fill();
        ctx.lineWidth = isPlayer ? 4 : 2;
        ctx.strokeStyle = isPlayer ? '#fff' : 'rgba(0,0,0,0.8)';
        ctx.stroke();
        if (isPlayer) {
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#000';
          ctx.stroke();
        }
      }
    }
  }

  // -------------------------------------------------------------- update

  update(data) {
    if (!data) return;
    const L = this._last;

    // Speed
    const maxSpeed = data.maxSpeed > 0 ? data.maxSpeed : 38;
    const speed = Math.abs(data.speed || 0);
    const kmh = Math.round(speed * 3.6);
    if (kmh !== L.speedKmh) {
      L.speedKmh = kmh;
      this.speedValue.textContent = String(kmh);
    }
    const ratio = Math.max(0, Math.min(1.15, speed / maxSpeed));
    const ratioQ = Math.round(ratio * 200) / 200;
    if (ratioQ !== L.speedRatio) {
      L.speedRatio = ratioQ;
      const shown = Math.min(1, ratioQ);
      this.speedoArc.setAttribute('stroke-dashoffset', (GAUGE_LEN * (1 - shown)).toFixed(2));
      const angle = GAUGE_START_DEG - 270 + GAUGE_SWEEP_DEG * shown;
      this.speedoNeedle.setAttribute('transform', `rotate(${angle.toFixed(2)} 100 100)`);
    }

    // Boost state
    const boosting = !!data.boosting;
    if (boosting !== L.boosting) {
      L.boosting = boosting;
      this.speedo.classList.toggle('boost', boosting);
    }

    // Drift tier ring
    const tier = data.driftTier | 0;
    if (tier !== L.driftTier) {
      L.driftTier = tier;
      this.driftRing.className = 'drift-ring' + (tier > 0 ? ' t' + Math.min(3, tier) : '');
    }

    // Lap
    const totalLaps = data.totalLaps || TOTAL_LAPS;
    const lap = Math.max(1, Math.min(totalLaps, data.lap | 0 || 1));
    if (lap !== L.lap || totalLaps !== L.totalLaps) {
      L.lap = lap;
      L.totalLaps = totalLaps;
      this.lapValue.textContent = `${lap}/${totalLaps}`;
      this.lap.classList.toggle('final', lap === totalLaps);
    }

    // Position
    const pos = Math.max(1, data.position | 0 || 1);
    const total = data.totalRacers || NUM_RACERS;
    if (pos !== L.position || total !== L.totalRacers) {
      const changed = L.position !== -1 && pos !== L.position;
      L.position = pos;
      L.totalRacers = total;
      this.posNumber.textContent = String(pos);
      this.posOrdinal.textContent = ordinal(pos);
      this.position.className = 'hud-position ' + (pos <= 3 ? 'p' + pos : 'pn');
      if (changed) {
        this.position.classList.add('bump');
        void this.position.offsetWidth;
      }
    }

    // Timer
    const timeStr = formatTime(data.time || 0);
    if (timeStr !== L.timeStr) {
      L.timeStr = timeStr;
      this.timer.textContent = timeStr;
    }

    // Wrong way
    const ww = !!data.wrongWay;
    if (ww !== L.wrongWay) {
      L.wrongWay = ww;
      this.wrongWay.classList.toggle('hidden', !ww);
    }

    // Item slot
    const roulette = data.rouletteItem || null;
    const item = roulette ? null : (data.item || null);
    const count = item ? Math.max(1, data.itemCount | 0 || 1) : 0;
    if (roulette !== L.rouletteItem || item !== L.item || count !== L.itemCount) {
      const hadItem = !!L.item;
      L.rouletteItem = roulette;
      L.item = item;
      L.itemCount = count;
      this._setItemIcon(roulette || item);
      this.itemCircle.classList.toggle('roulette', !!roulette);
      if (item && !hadItem && !roulette) {
        this.itemCircle.classList.remove('has-item');
        void this.itemCircle.offsetWidth;
        this.itemCircle.classList.add('has-item');
      } else if (!item) {
        this.itemCircle.classList.remove('has-item');
      }
      this.itemLabel.textContent = roulette ? '???' : (item ? (ITEM_LABELS[item] || item) : '');
      if (count > 1) {
        this.itemCount.textContent = '×' + count;
        this.itemCount.classList.remove('hidden');
      } else {
        this.itemCount.classList.add('hidden');
      }
    }

    // Minimap
    if (data.karts) this._drawMinimap(data.karts, false);
  }

  _setItemIcon(name) {
    const holder = this.itemIconHolder;
    const icon = name ? this.icons[name] : null;
    if (holder.firstChild === icon) return;
    while (holder.firstChild) holder.removeChild(holder.firstChild);
    if (icon) holder.appendChild(icon);
  }

  setFps(fps) {
    const v = Math.round(fps);
    if (v === this._last.fps) return;
    this._last.fps = v;
    this.fps.textContent = v > 0 ? `${v} FPS` : '';
  }

  // ----------------------------------------------------------- messages

  showCountdown(text) {
    const c = this.countdown;
    if (!text) {
      c.classList.remove('show', 'go');
      c.textContent = '';
      return;
    }
    c.textContent = text;
    c.classList.remove('show', 'go');
    void c.offsetWidth; // reflow → restart animation
    c.classList.add('show');
    if (text === 'GO!') c.classList.add('go');
  }

  showLapMessage(text) {
    const m = this.lapMsg;
    if (this._lapMsgTimer) clearTimeout(this._lapMsgTimer);
    m.textContent = text || '';
    m.classList.remove('show');
    void m.offsetWidth;
    m.classList.add('show');
    this._lapMsgTimer = setTimeout(() => {
      m.classList.remove('show');
      this._lapMsgTimer = 0;
    }, 2000);
  }

  // ------------------------------------------------------------ results

  showResults(standings) {
    const body = this.resultsBody;
    body.innerHTML = '';
    const rows = Array.isArray(standings) ? standings.slice() : [];
    rows.sort((a, b) => (a.position || 99) - (b.position || 99));
    rows.forEach((s, i) => {
      const pos = s.position || i + 1;
      const tr = document.createElement('tr');
      tr.className = (pos === 1 ? 'gold' : pos === 2 ? 'silver' : pos === 3 ? 'bronze' : '') + (s.isPlayer ? ' player' : '');
      const tdPos = el('td', null, tr, `${pos}${ordinal(pos)}`);
      const tdSw = el('td', null, tr);
      const sw = el('span', 'results-swatch', tdSw);
      sw.style.background = hexColor(s.color);
      el('td', null, tr, s.name || '');
      el('td', null, tr, typeof s.time === 'number' ? formatTime(s.time) : (s.time || '—'));
      void tdPos;
      body.appendChild(tr);
    });
    this.resultsEl.classList.add('visible');
  }

  hideResults() {
    this.resultsEl.classList.remove('visible');
  }

  // --------------------------------------------------------------- menu

  showMenu() {
    this.menuEl.classList.add('visible');
  }

  hideMenu() {
    this.menuEl.classList.remove('visible');
  }

  get menuVisible() {
    return this.menuEl.classList.contains('visible');
  }

  /** Wires click-on-menu and Enter → dispatches 'startrace' on window; runs callback. */
  onStart(callback) {
    if (typeof callback === 'function') this._startCallbacks.push(callback);
    if (this._startWired) return;
    this._startWired = true;
    const fire = () => {
      if (!this.menuVisible) return;
      window.dispatchEvent(new CustomEvent('startrace'));
    };
    this.menuEl.addEventListener('click', fire);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter') fire();
    });
    window.addEventListener('startrace', () => {
      for (const cb of this._startCallbacks) {
        try { cb(); } catch (err) { console.error(err); }
      }
    });
  }

  setVisible(visible) {
    this.root.classList.toggle('hidden', !visible);
  }

  // ------------------------------------------------------------ overlay

  showOverlayMessage(text, sub) {
    const o = this.overlayEl;
    o.innerHTML = '';
    const msg = el('div', 'overlay-msg', o, text);
    if (sub) el('span', 'overlay-sub', msg, sub);
  }

  showError(message) {
    const o = this.overlayEl;
    o.innerHTML = '';
    const box = el('div', 'overlay-error', o);
    el('div', 'err-title', box, 'Something went wrong');
    el('div', null, box, String(message));
  }

  hideOverlay() {
    this.overlayEl.innerHTML = '';
  }

  // ------------------------------------------------------------ loading

  setLoading(progress, text) {
    const l = this.loadingEl;
    if (!l) return;
    l.classList.remove('hidden', 'fade');
    const fill = l.querySelector('.loading-fill');
    if (fill) fill.style.width = `${Math.round(Math.max(0, Math.min(1, progress || 0)) * 100)}%`;
    if (text != null) {
      const t = l.querySelector('.loading-text');
      if (t) t.textContent = text;
    }
  }

  hideLoading() {
    const l = this.loadingEl;
    if (!l) return;
    l.classList.add('fade');
    setTimeout(() => l.classList.add('hidden'), 520);
  }
}

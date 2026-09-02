// Smoke test for src/hud.js under jsdom (canvas 2D is unavailable there → ctx null paths).
// Run: node tests/hud-smoke.mjs   (requires `npm i jsdom --no-save` in the project root)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { JSDOM, VirtualConsole } = await import('jsdom');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', () => {}); // silence "not implemented: getContext"
const dom = new JSDOM(html, { pretendToBeVisual: true, virtualConsole });
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.CustomEvent = window.CustomEvent;
globalThis.HTMLElement = window.HTMLElement;
if (!globalThis.performance) globalThis.performance = window.performance;

const { HUD } = await import('../src/hud.js');
const { TOTAL_LAPS, KART_COLORS } = await import('../src/constants.js');

const hud = new HUD();
const $ = (sel) => document.querySelector(sel);

// DOM built inside the containers
assert.ok($('#hud .hud-item'), 'item slot built');
assert.ok($('#hud .hud-speedo svg path.speedo-arc'), 'speedometer arc built');
assert.ok($('#hud .hud-minimap canvas'), 'minimap canvas built');
assert.ok($('#menu .menu-logo'), 'menu logo built');
assert.ok($('#results table'), 'results table built');
assert.equal(hud.minimapCtx, null, 'jsdom has no canvas ctx (null path exercised)');

// Minimap track + karts (ctx null → must not throw)
const points = [];
for (let i = 0; i < 200; i++) {
  const a = (i / 200) * Math.PI * 2;
  points.push({ x: Math.cos(a) * 150, z: Math.sin(a) * 90 });
}
assert.doesNotThrow(() => hud.setMinimapTrack(points));
assert.ok(hud._minimap.bounds, 'minimap bounds computed');
hud.setMinimapTrack([]); // degenerate input ok
hud.setMinimapTrack(points);

const karts = KART_COLORS.map((c, i) => ({ x: i * 10, z: -i * 5, color: c, isPlayer: i === 0 }));

const full = {
  speed: 30, maxSpeed: 38, lap: 2, totalLaps: TOTAL_LAPS, position: 4, totalRacers: 8,
  item: 'triple_mushroom', itemCount: 3, driftTier: 2, time: 83.456, wrongWay: true,
  karts, rouletteItem: null, boosting: true,
};
assert.doesNotThrow(() => hud.update(full));
assert.equal($('#hud .speed-value').textContent, '108', 'km/h readout');
assert.equal($('#hud .lap-value').textContent, `2/${TOTAL_LAPS}`);
assert.equal($('#hud .pos-number').textContent, '4');
assert.equal($('#hud .pos-ordinal').textContent, 'th');
assert.equal($('#hud .hud-timer').textContent, '01:23.45');
assert.equal($('#hud .item-label').textContent, 'Triple Mushroom');
assert.equal($('#hud .item-count').textContent, '×3');
assert.ok(!$('#hud .item-count').classList.contains('hidden'));
assert.ok($('#hud .item-circle canvas'), 'item icon canvas shown');
assert.ok($('#hud .drift-ring').classList.contains('t2'));
assert.ok($('#hud .hud-speedo').classList.contains('boost'));
assert.ok(!$('#hud .hud-wrongway').classList.contains('hidden'), 'wrong way visible');
assert.ok($('#hud .hud-position').classList.contains('pn'));

// Cheap update: identical data must not change the DOM
const arcBefore = $('#hud .speedo-arc').getAttribute('stroke-dashoffset');
hud.update(full);
assert.equal($('#hud .speedo-arc').getAttribute('stroke-dashoffset'), arcBefore);

// Changed data
hud.update({ ...full, speed: 0, position: 1, item: null, itemCount: 0, rouletteItem: 'star', driftTier: 0, boosting: false, wrongWay: false, lap: 3 });
assert.equal($('#hud .speed-value').textContent, '0');
assert.equal($('#hud .pos-number').textContent, '1');
assert.equal($('#hud .pos-ordinal').textContent, 'st');
assert.ok($('#hud .hud-position').classList.contains('p1'));
assert.ok($('#hud .hud-position').classList.contains('bump'), 'position change bumps');
assert.equal($('#hud .item-label').textContent, '???');
assert.ok($('#hud .item-circle').classList.contains('roulette'));
assert.ok($('#hud .item-count').classList.contains('hidden'));
assert.equal($('#hud .drift-ring').className, 'drift-ring');
assert.ok(!$('#hud .hud-speedo').classList.contains('boost'));
assert.ok($('#hud .hud-wrongway').classList.contains('hidden'));
assert.ok($('#hud .hud-lap').classList.contains('final'));
hud.update({ ...full, rouletteItem: null, item: 'banana', itemCount: 1 });
assert.equal($('#hud .item-label').textContent, 'Banana');
assert.ok(!$('#hud .item-circle').classList.contains('roulette'));

// Partial / odd data must not throw
assert.doesNotThrow(() => hud.update({}));
assert.doesNotThrow(() => hud.update(null));
assert.doesNotThrow(() => hud.update({ speed: NaN, position: 22, item: 'unknown_item', karts: [null] }));
assert.equal($('#hud .pos-ordinal').textContent, 'nd');

// Countdown / lap message
hud.showCountdown('3');
assert.equal($('#hud .hud-countdown').textContent, '3');
assert.ok($('#hud .hud-countdown').classList.contains('show'));
hud.showCountdown('GO!');
assert.ok($('#hud .hud-countdown').classList.contains('go'));
hud.showCountdown('');
assert.ok(!$('#hud .hud-countdown').classList.contains('show'));
hud.showLapMessage('FINAL LAP!');
assert.equal($('#hud .hud-lapmsg').textContent, 'FINAL LAP!');
assert.ok($('#hud .hud-lapmsg').classList.contains('show'));

// Results
const standings = KART_COLORS.map((c, i) => ({
  name: `Racer ${i}`, color: c, time: i < 6 ? 100 + i * 3.21 : null, isPlayer: i === 2, position: i + 1,
})).reverse();
hud.showResults(standings);
assert.ok($('#results').classList.contains('visible'));
const rows = document.querySelectorAll('#results tbody tr');
assert.equal(rows.length, 8);
assert.ok(rows[0].classList.contains('gold'));
assert.ok(rows[1].classList.contains('silver'));
assert.ok(rows[2].classList.contains('bronze'));
assert.ok(rows[2].classList.contains('player'));
assert.equal(rows[0].children[0].textContent, '1st');
assert.equal(rows[0].children[3].textContent, '01:40.00');
assert.equal(rows[7].children[3].textContent, '—');
hud.hideResults();
assert.ok(!$('#results').classList.contains('visible'));

// Menu + start wiring
let starts = 0;
hud.onStart(() => starts++);
hud.showMenu();
assert.ok(hud.menuVisible);
$('#menu').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
assert.equal(starts, 1, 'click on menu fires start');
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
assert.equal(starts, 2, 'Enter fires start');
hud.hideMenu();
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
assert.equal(starts, 2, 'no start while menu hidden');

// Visibility / overlay / loading / fps
hud.setVisible(false);
assert.ok($('#hud').classList.contains('hidden'));
hud.setVisible(true);
hud.showOverlayMessage('PAUSED', 'sub');
assert.ok($('#overlay .overlay-msg'));
hud.showError('boom');
assert.ok($('#overlay .overlay-error'));
hud.hideOverlay();
assert.equal($('#overlay').children.length, 0);
hud.setLoading(0.5, 'Half way');
assert.equal($('#loading .loading-fill').style.width, '50%');
assert.equal($('#loading .loading-text').textContent, 'Half way');
hud.hideLoading();
assert.ok($('#loading').classList.contains('fade'));
hud.setFps(59.6);
assert.equal($('#hud .hud-fps').textContent, '60 FPS');

console.log('hud-smoke: OK');
process.exit(0);

# Turbo Kart Grand Prix — Architecture Contract

A Mario Kart–inspired 3D kart racer built with Three.js (ES modules, no bundler).
Every module is a plain ES module under `src/`. Three.js is loaded via an import map
(`import * as THREE from 'three'`; addons via `three/addons/...`). Version: three@0.160.0.

**ALL assets are procedural** (canvas-generated textures, procedurally built geometry,
WebAudio-synthesised sound). No external files, no network fetches other than the three.js CDN.
Quality bar: AAA-feel — toon/stylised but rich: fenders, rims, helmets, spoilers, exhaust,
checkered curbs, grandstands, trees, mountains, clouds, balloons, flags, shadows, fog,
ACES tone mapping, bloom-free but strong lighting.

Coordinate conventions: Y is up. Heading `yaw` is rotation around Y; forward vector is
`(Math.sin(yaw), 0, Math.cos(yaw))`. Units are metres. Kart ≈ 2.2 m long, 1.6 m wide. Road width 16 m.

Every module must be self-contained and free of side effects at import time (no DOM access at
top-level except querying elements inside constructors). Shared constants live in `src/constants.js`.

---

## src/constants.js  (already written — DO NOT change signatures, may add)

```js
export const ROAD_WIDTH = 16;
export const TOTAL_LAPS = 3;
export const NUM_RACERS = 8;
export const KART_COLORS = [...8 hex colors...];
export const KART_NAMES  = [...8 names...];
export const ITEM_TYPES = ['mushroom','triple_mushroom','banana','green_shell','red_shell','star','lightning','bomb'];
```

## src/track.js  — `export class Track`

```js
const track = new Track(scene);          // builds road + scenery, adds everything to scene
track.curve        // THREE.CatmullRomCurve3, closed, centripetal. Road centre-line. Has gentle hills (Y varies).
track.roadWidth    // === ROAD_WIDTH
track.group        // THREE.Group containing all track meshes (road, curbs, walls, scenery)
track.length       // approx curve length in metres (use curve.getLength())
track.startPositions  // Array<{ position: THREE.Vector3, yaw: number }> — 8 grid slots, staggered 2x4,
                      // BEHIND the start/finish line (t slightly < 1.0 i.e. just before t=0), facing +t direction
track.startLineT      // number in [0,1], the t of the finish line (use 0)
track.checkpoints     // Array<{ t: number, position: THREE.Vector3, tangent: THREE.Vector3 }> — 24 evenly spaced,
                      // checkpoints[0] is the start line (t=0)
track.itemBoxPositions // Array<THREE.Vector3> — rows of item boxes across the road (e.g. 4 rows of 4), y = road surface + 1.2
track.boostPads        // Array<{ position: THREE.Vector3, yaw: number, t: number }> — 3–4 orange boost pads (visual mesh built here)
track.minimapPoints    // Array<{x:number, z:number}> — 200 points sampled along curve for HUD minimap

track.getRoadInfo(position: THREE.Vector3, hintT?: number) => {
  t,                // closest curve param in [0,1). If hintT given, search locally around it (fast path). Must handle wrap.
  center,           // THREE.Vector3 point on curve at t
  tangent,          // THREE.Vector3 unit forward direction at t (XZ mostly, includes slope)
  right,            // THREE.Vector3 unit right vector (tangent × up)
  lateral,          // signed distance from centre-line along `right` (metres). +right, -left
  height,           // road surface height (Y) at this position (for setting kart Y)
  surface,          // 'road' | 'offroad' | 'boost'   (offroad when |lateral| > roadWidth/2; boost when on a boost pad)
  onRoad,           // boolean
  wallDistance,     // roadWidth/2 + WALL_MARGIN (constant 6): |lateral| beyond this is a hard barrier
}
track.update(dt, elapsed)   // animates flags, balloons, spectators, water etc.
```

The track must be a fun closed circuit ~900–1200 m long: long straight for the start/finish, sweeping S-curves, a hairpin, a hill section, and a wide chicane. Terrain (grass) extends far beyond the road with a skirt; offroad is visibly grass/dirt. Barriers: low tyre walls / coloured rails at `wallDistance`. Include: start/finish gantry with checkered banner, grandstands with animated spectators, trees (varied), distant mountains, floating balloons, flag posts, palm trees or pines, and a large ground plane. Road texture: asphalt with subtle noise, white edge lines, dashed centre line. Curbs: red/white checkered strips along both edges.

Textures must be generated with a `<canvas>` → `THREE.CanvasTexture`, with proper `wrapS/wrapT = RepeatWrapping`, `colorSpace = SRGBColorSpace`, anisotropy set from the renderer if available (accept optional `renderer` as 2nd constructor arg: `new Track(scene, renderer)`).

## src/environment.js — `export class Environment`

```js
const env = new Environment(scene, renderer);   // sky, sun light w/ shadows, hemisphere light, fog, clouds
env.sunLight        // THREE.DirectionalLight (castShadow true, shadow camera covering ~250 m around target)
env.update(dt, elapsed, focusPosition)  // moves shadow camera target with the player, drifts clouds
```

Sky: gradient sky dome (custom ShaderMaterial or large sphere with vertex colours) + a sun disc + stylised cloud sprites/meshes. Fog matches horizon colour.

## src/kart.js — `export class Kart`

```js
const kart = new Kart(scene, { color: 0xff0000, name: 'Player', isPlayer: true, index: 0 });
kart.group            // THREE.Group, add to scene in constructor. Visual root.
kart.position         // getter → kart.group.position
kart.yaw              // heading in radians
kart.speed            // signed forward speed (m/s). Top speed ~ 38 m/s normal.
kart.velocity         // THREE.Vector3 world velocity (derived; used by collisions)
kart.maxSpeed         // current cap (modified by boosts / surface)
kart.radius           // 1.2 (collision circle)
kart.isPlayer, kart.name, kart.color, kart.index
kart.lap              // integer starting at 0 (becomes 1 after crossing start line the first time is NOT counted — see main.js)
kart.nextCheckpoint   // index into track.checkpoints
kart.trackT           // latest closest t on curve (cached hint)
kart.progress         // lap + trackT-ish continuous progress used for race ordering (main.js maintains)
kart.racePosition     // 1..8 (main.js sets)
kart.finished, kart.finishTime
kart.item             // null | ITEM_TYPES entry;  kart.itemCount (for triple mushroom)
kart.state = { drifting:false, driftDir:0, driftCharge:0, driftTier:0, hopTimer:0, boostTimer:0, boostPower:0,
               spinTimer:0, stunTimer:0, invincibleTimer:0, shrinkTimer:0, airborne:false, wrongWay:false }
kart.input = { throttle:0..1, brake:0..1, steer:-1..1, drift:boolean, useItem:boolean, lookBack:boolean }

kart.update(dt, track)      // integrates physics using kart.input, snaps Y to road height, handles walls, offroad, boost pads
kart.applyBoost(duration, power)   // power: 1.0 = mini-turbo, 1.4 = mushroom
kart.spinOut()              // banana/shell hit: spin 360°, lose speed, 1 s stun. Ignored if invincible.
kart.crash()                // bomb/lightning-strength: bigger tumble, 1.5 s stun
kart.setStar(duration)      // invincible + rainbow flash + speed boost
kart.setShrink(duration)    // lightning: scale 0.5, slow
kart.setEffects(particles, audio)   // optional hooks: kart calls particles.emitDrift/emitBoost/emitDust and audio cues
```

Physics feel (Mario Kart 8-like): acceleration curve with ~2.5 s to top speed; steering rate reduced at high speed; slight outward body roll; **drift**: press drift (hop) while steering → small hop, then kart slides with a fixed drift direction; steering during drift tightens/widens the arc; charge accumulates (0→1 over 1.2 s → tier1 blue, tier2 orange at 2.4 s, tier3 purple/pink at 3.6 s); releasing drift grants a mini-turbo whose duration scales with tier. Offroad halves max speed unless boosting/star. Walls: clamp lateral to ±wallDistance, kill lateral velocity, lose 30% speed, small bounce. Reverse allowed with brake when stopped. Wheels rotate with speed and front wheels turn with steer; body tilts in drift. Boost visually stretches a flame cone from exhaust (kart.js owns that mesh).

Visual: procedurally built kart — chassis with fenders and a low nose, side pods, rear spoiler, two exhaust pipes, 4 wheels with rubber tread + chrome rims, a seated driver (helmet with visor, body, arms on wheel), number plate with `index+1`. Materials: MeshStandardMaterial with metalness/roughness; castShadow on all pieces. Kart colours from `KART_COLORS`.

## src/input.js — `export class Input`

```js
const input = new Input();          // attaches keydown/keyup listeners; also gamepad polling
input.update()                      // call once per frame (polls gamepad)
input.state → { throttle, brake, steer, drift, useItem, lookBack, pause, confirm, restart }
input.consumeUseItem()              // returns true once per press
input.consumeConfirm()
Keys: Arrow keys / WASD steer+throttle, Shift or Space = drift/hop, Ctrl or E or Enter = use item, R = restart, Esc/P = pause, Down/S = brake/reverse
```

## src/ai.js — `export class AIController`

```js
const ai = new AIController(kart, track, { skill: 0.6 });   // skill 0..1
ai.update(dt, karts, itemManager)   // writes kart.input (throttle, steer, drift, useItem) each frame
```

AI follows a look-ahead point on `track.curve` (≈ 12–25 m ahead scaled with speed), with a per-AI lateral offset that changes over time so they don't form a train, drifts on sharp curves, avoids bananas/shells if visible ahead, uses items sensibly (shells when a kart is ahead, banana when someone is close behind, mushroom on straights), rubber-banding: slightly faster when far behind player, slightly slower when far ahead. Must handle recovery when facing backward or stuck against a wall (reverse briefly).

## src/items.js — `export class ItemManager`

```js
const items = new ItemManager(scene, track, particles, audio);
items.update(dt, karts)   // spins item boxes, respawns, moves projectiles, resolves hits with karts
items.tryUse(kart, karts) // called when kart wants to use its item; consumes it; returns true if used
items.rollItem(kart)      // sets kart.item weighted by kart.racePosition (1st: banana/green; 8th: star/lightning/bomb)
items.hazards             // Array of { position, radius, type } for AI avoidance (bananas + shells)
items.reset()
```

Item boxes: rotating translucent rainbow cubes with a '?' inside, bob up/down, respawn 3 s after pickup with a pop. Pickup gives a 1.5 s roulette then `rollItem`. Items:
- mushroom / triple_mushroom: `kart.applyBoost(1.2, 1.4)`
- banana: dropped behind (or thrown ahead if throttle+lookBack? keep simple: behind); kart touching → `spinOut()`
- green_shell: fires straight ahead at 45 m/s, bounces off walls up to 3 times, hits → `spinOut()`
- red_shell: homes on next kart ahead along the track, 42 m/s
- star: `kart.setStar(8)`; touching others spins them out
- lightning: all other karts `setShrink(5)` + spin; the user is immune
- bomb: thrown forward, explodes on contact or after 2.5 s, radius 6 → `crash()` for karts in radius

All item meshes must be procedural and pretty (shells with spikes/shine, banana with brown stem, bomb with fuse spark).

## src/particles.js — `export class ParticleSystem`

```js
const particles = new ParticleSystem(scene);
particles.emitDrift(position, tier /*0..3*/, rightVector)   // sparks at rear wheels; colour by tier (0 grey dust,1 blue,2 orange,3 pink/purple)
particles.emitBoost(position, dirVector, power)             // fire trail
particles.emitDust(position)                                // offroad dust
particles.emitExplosion(position)                           // bomb
particles.emitPop(position, color)                          // item box burst / pickup
particles.emitConfetti(position)                            // finish
particles.update(dt)
```
Use a pooled `THREE.Points` or InstancedMesh approach — must handle thousands of particles at 60 fps.

## src/audio.js — `export class AudioManager`

```js
const audio = new AudioManager();
audio.init()   // must be called from a user gesture; creates AudioContext. Safe to call repeatedly.
audio.setEngine(speedRatio /*0..1*/, boosting /*bool*/, drifting)   // continuous engine hum (oscillators + noise), pitch with speed
audio.play(name) // one-shots: 'hop','drift_tier1','drift_tier2','drift_tier3','boost','item_pickup','item_roulette','shell_fire','shell_hit','banana','star','lightning','bomb','countdown_beep','countdown_go','lap','finish','wall','menu'
audio.startMusic(track /*'menu'|'race'|'results'*/), audio.stopMusic()   // procedural chiptune-ish loop using scheduled oscillators
audio.setStarMusic(on)
audio.setVolume(v)
```

## src/hud.js — `export class HUD`

```js
const hud = new HUD();     // builds DOM elements inside #hud (index.html provides #hud, #menu, #results, #overlay containers)
hud.setMinimapTrack(track.minimapPoints)
hud.update({ speed, maxSpeed, lap, totalLaps, position, totalRacers, item, itemCount, driftTier, time, wrongWay, karts /*for minimap: [{x,z,color,isPlayer}]*/, rouletteItem /*string|null while rolling*/, boosting })
hud.showCountdown(text /* '3','2','1','GO!' or '' */)
hud.showLapMessage(text /* 'FINAL LAP!' etc. */)
hud.showResults(standings /* [{name,color,time,isPlayer,position}] */)
hud.hideResults()
hud.showMenu(), hud.hideMenu()      // title screen with logo, "Press ENTER / click to race", controls list
hud.setVisible(bool)
```
Style: bold rounded fonts (system font stack, e.g. 'Segoe UI Black', Arial Black), thick outlines, item slot circle top-left, position number huge bottom-left with ordinal, lap counter top-right, speedometer arc bottom-right, minimap right-middle. Wrong-way flashing warning. Everything via CSS in `styles.css` (you own it).

## src/main.js — game orchestration (owns the loop)

- Creates renderer (antialias, shadowMap PCFSoft, ACESFilmic, sRGB), scene, camera (PerspectiveCamera 60° fov).
- Instantiates Environment, Track, ParticleSystem, AudioManager, ItemManager, HUD, Input, 8 Karts (player index 0, colour KART_COLORS[0]) placed on `track.startPositions`, AI for 1..7 with skills 0.45–0.9.
- State machine: `menu → countdown → racing → finished`. Menu: press Enter/click → audio.init(), start countdown (3,2,1,GO with beeps; karts locked). Racing: fixed-timestep physics (1/120 s, max 4 substeps), kart-kart collisions (circle push-apart + speed exchange), lap/checkpoint logic (must pass checkpoints in order; crossing start after checkpoint N-1 increments lap; lap > TOTAL_LAPS → finished), wrong-way detection (velocity·tangent < 0 for > 1 s), race ordering by `progress = lap + t` (with checkpoint validation), AI auto-drives player after they finish. Finished: results screen sorted, press Enter/R restart.
- Camera: chase cam behind kart, position lerped, look-at lerped ahead of kart, FOV widens with boost (60→75), slight lateral offset during drift, look-back camera when lookBack held. Camera must not clip through terrain (keep ≥ 1.5 m above road height).
- Resize handling, pause (P/Esc), restart (R).
- Exposes `window.__game` = { karts, track, state, restart(), getFps() } for automated testing.
- Fps counter in corner (small).

## index.html
Provided. Contains import map, `<canvas id="game">`, `#hud`, `#menu`, `#results`, `#overlay`, `#loading`, and `<script type="module" src="./src/main.js">`.

## Performance targets
60 fps on an integrated GPU at 1080p: ≤ 400 draw calls, InstancedMesh for trees/spectators/particles, merged geometry for track decorations, shadow map 2048.

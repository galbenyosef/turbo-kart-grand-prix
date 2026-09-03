// dev/trailer-director.js — cinematic shot scripting for the trailer capture (dev only).
// Load in the running game page, then: await __trailer.run('s01') … each call captures one shot
// deterministically (the sim steps 1/30 s per frame) and uploads the frames to the dev server.
(() => {
  const g = window.__game;
  if (!g) throw new Error('game not ready');
  const Vec = g.player.position.constructor;
  const V = (x = 0, y = 0, z = 0) => new Vec(x, y, z);
  const src = document.getElementById('game');
  const canvas = document.createElement('canvas');
  canvas.width = 1280; canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const track = g.track, curve = g.track.curve;

  const wrap = (t) => ((t % 1) + 1) % 1;
  const lerp = (a, b, k) => a + (b - a) * k;
  const ease = (k) => k * k * (3 - 2 * k);
  const player = () => g.player;

  /** World point at curve t, offset laterally (metres, +right) and vertically. */
  function roadPoint(t, lateral = 0, height = 0) {
    const p = curve.getPointAt(wrap(t));
    const info = track.getRoadInfo(p);
    const r = info.right;
    return V(p.x + r.x * lateral, p.y + height, p.z + r.z * lateral);
  }
  function setCam(pos, look, fov = 50) {
    g.camera.position.copy(pos);
    g.camera.lookAt(look);
    if (g.camera.fov !== fov) { g.camera.fov = fov; g.camera.updateProjectionMatrix(); }
  }
  function grabFrame() { ctx.drawImage(src, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/jpeg', 0.92); }
  async function upload(list, prefix) {
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      const blob = await (await fetch(list[i])).blob();
      const res = await fetch(`/__save?name=${prefix}_${String(i).padStart(4, '0')}.jpg`, { method: 'POST', body: blob });
      if (res.ok) ok++;
    }
    return ok;
  }
  /**
   * Steps the sim 1/30 s per frame and captures. camFn(k, i) positions the camera (k 0..1);
   * with gameCam the game's own chase camera renders instead. Captured synchronously so the
   * background watchdog cannot advance the sim between frames.
   */
  function runShot(frames, camFn, opts = {}) {
    const out = [];
    for (let i = 0; i < frames; i++) {
      const k = frames > 1 ? i / (frames - 1) : 0;
      opts.pre?.(i, k);
      g.frame(1 / 60, false);
      g.frame(1 / 60, !!opts.gameCam);
      if (!opts.gameCam) { camFn(k, i); g.renderer.render(g.scene, g.camera); }
      out.push(grabFrame());
    }
    return out;
  }
  const lock = (on) => { for (const k of g.karts) k.locked = on; };
  const untilT = (t0, t1, max = 8000) => { let n = 0; while (n++ < max && !(player().trackT > t0 && player().trackT < t1)) g.frame(1 / 60, false); return n; };
  const standCentres = () => {
    const out = [];
    g.track.group.traverse((o) => { if (o.name === 'grandstand_empty') { const p = V(); o.getWorldPosition(p); out.push(p); } });
    return out;
  };
  const freshRace = () => {
    g.setPaused(false);
    if (g.state === 'menu') g.startRace(); else g.restart();
    g.skipCountdown();
    g.setPlayerAI(true);
    g.player.speedMultiplier = 1;
  };

  const shots = {
    /** Bird's-eye descent from high above the straight onto the grid (karts held on the line). */
    s01: async () => {
      freshRace(); lock(true);
      for (let i = 0; i < 30; i++) g.frame(1 / 60, false);
      const grid = roadPoint(0.99, 0, 0);
      const frames = runShot(150, (k) => {
        const e = ease(k);
        setCam(roadPoint(0.905 + 0.045 * e, -19 * e, lerp(120, 12, e)), V(grid.x, grid.y + 1, grid.z), lerp(42, 52, e));
      });
      return upload(frames, 's01');
    },
    /** Slow pan along the front of the stand nearest the grid, fans cheering. */
    s02: async () => {
      lock(true);
      const grid = roadPoint(0.99, 0, 0);
      const stands = standCentres().sort((a, b) => a.distanceTo(grid) - b.distanceTo(grid));
      const s = stands[0];
      const info = track.getRoadInfo(s);
      const r = info.right, tg = info.tangent, side = Math.sign(info.lateral) || 1;
      const frames = runShot(120, (k) => {
        const along = lerp(-16, 16, k);
        const pos = V(s.x + tg.x * along - r.x * side * 10, s.y + 4.2, s.z + tg.z * along - r.z * side * 10);
        const look = V(s.x + tg.x * (along + 3) + r.x * side * 2, s.y + 5.2, s.z + tg.z * (along + 3) + r.z * side * 2);
        setCam(pos, look, 40);
      });
      return upload(frames, 's02');
    },
    /** Low front-corner shot of the grid; the karts launch at 2.5 s. */
    s03: async () => {
      lock(true);
      const cam = roadPoint(0.012, 6, 1.0);
      const look = roadPoint(0.986, -1.5, 0.7);
      const frames = runShot(105, (k, i) => {
        if (i === 75) lock(false);
        setCam(V(cam.x, cam.y + 0.3 * k, cam.z), V(look.x, look.y, look.z), 38);
      });
      return upload(frames, 's03');
    },
    /** Chase-cam action through the first sweeper (the game's own camera). */
    s04: async () => {
      lock(false); untilT(0.035, 0.05);
      const frames = runShot(150, null, { gameCam: true });
      return upload(frames, 's04');
    },
    /** Hairpin drift: fixed trackside camera on the outside, tracking the player. */
    s05: async () => {
      untilT(0.43, 0.445);
      const cam = roadPoint(0.47, 22, 4.5);
      const frames = runShot(120, () => { const p = player().position; setCam(cam, V(p.x, p.y + 0.8, p.z), 36); });
      return upload(frames, 's05');
    },
    /** Red shell fired from a high rear camera. */
    s06: async () => {
      untilT(0.60, 0.62);
      player().item = 'red_shell'; player().itemCount = 1; player().rouletteTimer = 0;
      const frames = runShot(120, (k, i) => {
        if (i === 12) g.items.tryUse(player(), g.karts);
        const p = player(); const f = p.forwardVector();
        setCam(V(p.position.x - f.x * 9, p.position.y + 4.5, p.position.z - f.z * 9), V(p.position.x + f.x * 14, p.position.y + 0.5, p.position.z + f.z * 14), 52);
      });
      return upload(frames, 's06');
    },
    /** Star fly-by past a roadside camera. */
    s07: async () => {
      untilT(0.15, 0.165);
      player().setStar(8);
      const cam = roadPoint(0.195, -12, 2.4);
      const frames = runShot(90, () => { const p = player().position; setCam(cam, V(p.x, p.y + 0.6, p.z), 34); });
      return upload(frames, 's07');
    },
    /** Under the hill arch, looking back down at the climbing pack, camera sinking. */
    s08: async () => {
      untilT(0.50, 0.515);
      const cam = roadPoint(0.548, 0, 7.5);
      const frames = runShot(90, (k) => { const p = player().position; setCam(V(cam.x, cam.y - 3.5 * k, cam.z), V(p.x, p.y + 0.5, p.z), 44); });
      return upload(frames, 's08');
    },
    /** Finish line from the arch top, stands either side, player crossing. */
    s09: async () => {
      untilT(0.955, 0.97);
      const cam = roadPoint(0.004, 0, 13.5);
      const frames = runShot(120, () => { const p = player().position; setCam(cam, V(p.x, p.y, p.z), 56); });
      return upload(frames, 's09');
    },
    /** End card: slow orbit of the player kart on the grid. */
    s10: async () => {
      freshRace(); lock(true);
      for (let i = 0; i < 20; i++) g.frame(1 / 60, false);
      const p = player().position.clone();
      const frames = runShot(135, (k) => {
        const a = 0.5 + k * 1.3;
        setCam(V(p.x + Math.sin(a) * 5.2, p.y + 1.9, p.z + Math.cos(a) * 5.2), V(p.x, p.y + 0.7, p.z), 36);
      });
      return upload(frames, 's10');
    },
  };
  window.__trailer = { shots, run: (name) => shots[name](), roadPoint, standCentres };
})();

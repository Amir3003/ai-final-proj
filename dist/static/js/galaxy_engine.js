/* QUASAR-ARB · galaxy_engine.js
 * 60fps Canvas-2D spiral galaxy: 6,000+ particles, volumetric nebula/dust blobs, a quasar core with jets,
 * 3-layer warp starfield, scroll-driven z-axis dive (z: 1000 -> 50) and a continuous multi-wavelength shader
 * (VISIBLE -> INFRARED -> X-RAY -> MULTI-WAVELENGTH) that re-colours every particle.
 */
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const frac = (x) => x - Math.floor(x);
  const smooth = (x) => x * x * (3 - 2 * x);
  function mulberry(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry(20260611);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(TAU * rnd());

  const WAVES = ['VISIBLE', 'INFRARED', 'X-RAY', 'MULTI-WAVELENGTH'];

  /* ---- sprites -------------------------------------------------------------------- */
  const spriteCache = new Map();
  function glowSprite(r, g, b, size = 64) {
    const key = r + ',' + g + ',' + b + ',' + size;
    if (spriteCache.has(key)) return spriteCache.get(key);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gr.addColorStop(0, `rgba(${r},${g},${b},1)`);
    gr.addColorStop(0.18, `rgba(${r},${g},${b},0.55)`);
    gr.addColorStop(0.55, `rgba(${r},${g},${b},0.12)`);
    gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
    x.fillStyle = gr; x.fillRect(0, 0, size, size);
    spriteCache.set(key, c);
    return c;
  }
  function cloudSprite(r, g, b, size = 128) {   // lumpy volumetric blob
    const key = 'c' + r + ',' + g + ',' + b;
    if (spriteCache.has(key)) return spriteCache.get(key);
    const c = document.createElement('canvas'); c.width = c.height = size;
    const x = c.getContext('2d');
    const rr = mulberry(r * 7 + g * 13 + b * 29);
    for (let i = 0; i < 9; i++) {
      const px = size / 2 + (rr() - 0.5) * size * 0.38, py = size / 2 + (rr() - 0.5) * size * 0.38;
      const rad = size * (0.2 + rr() * 0.22);
      const gr = x.createRadialGradient(px, py, 0, px, py, rad);
      gr.addColorStop(0, `rgba(${r},${g},${b},0.42)`);
      gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
      x.fillStyle = gr; x.fillRect(0, 0, size, size);
    }
    spriteCache.set(key, c);
    return c;
  }

  /* ---- the engine ----------------------------------------------------------------- */
  class GalaxyEngine {
    constructor(canvas) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d', { alpha: false });
      this.t = 0; this.last = performance.now();
      this.progress = 0; this.target = 0; this.vel = 0;
      this.wave = 0; this.waveTarget = 0; this.weights = [1, 0, 0];
      this.threat = 0; this.mx = 0; this.my = 0; this.pulses = [];
      this.quality = 1; this.fps = 60; this._frames = 0; this._fpsT = performance.now();
      this.state = { progress: 0, z: 1000, layer: 1 };
      this.dirty = true;
      this.build();
      this.resize();
      addEventListener('resize', () => this.resize());
      addEventListener('pointermove', (e) => { this.mx = e.clientX / innerWidth - 0.5; this.my = e.clientY / innerHeight - 0.5; }, { passive: true });
      this.running = true;
      requestAnimationFrame((n) => this.frame(n));
    }

    build() {
      const N_ARM = 3600, N_BULGE = 1100, N_HII = 220, N_XR = 120, N_HALO = 520;
      const N = N_ARM + N_BULGE + N_HII + N_XR + N_HALO;
      this.N = N;
      const A = (k) => new Float32Array(N);
      Object.assign(this, { r: A(), th: A(), h: A(), om: A(), size: A(), kind: new Uint8Array(N),
        bv: A(), bi: A(), bx: A(), cvR: A(), cvG: A(), cvB: A(), cxR: A(), cxG: A(), cxB: A(),
        px: A(), py: A(), pd: A(), sx: A(), sy: A(), rgb: new Uint32Array(N), order: new Uint32Array(N) });
      const arms = () => { const u = rnd(); return u < 0.4 ? 0 : u < 0.8 ? Math.PI : u < 0.9 ? Math.PI / 2 : -Math.PI / 2; };
      let i = 0;
      const set = (kind, r, th, h, size, bv, bi, bx, cv, cx) => {
        this.kind[i] = kind; this.r[i] = r; this.th[i] = th; this.h[i] = h; this.size[i] = size;
        this.om[i] = 0.9 / Math.sqrt(Math.max(r, 20) / 40) * 0.05;     // slow differential rotation
        this.bv[i] = bv; this.bi[i] = bi; this.bx[i] = bx;
        this.cvR[i] = cv[0]; this.cvG[i] = cv[1]; this.cvB[i] = cv[2];
        this.cxR[i] = cx[0]; this.cxG[i] = cx[1]; this.cxB[i] = cx[2]; i++;
      };
      const armTheta = (r, base) => base + 2.0 * Math.log(r / 38);
      for (let k = 0; k < N_ARM; k++) {                       // arm stars
        const r = 46 + 560 * Math.pow(rnd(), 1.55);
        const th = armTheta(r, arms()) + gauss() * (0.15 + 0.12 * r / 600);
        const blue = rnd();
        set(0, r, th, gauss() * (6 + 10 * Math.exp(-r / 120)), 0.8 + rnd() * 1.1, 0.28 + rnd() * 0.55, 0.22 + rnd() * 0.2, 0.01,
          [150 + 80 * blue, 175 + 55 * blue, 255], [90, 150, 255]);
      }
      for (let k = 0; k < N_BULGE; k++) {                     // bulge
        const r = Math.abs(gauss()) * 55 + 4, th = rnd() * TAU;
        set(1, r, th, gauss() * 26 * Math.exp(-r / 150), 0.8 + rnd() * 1.3, 0.35 + rnd() * 0.5, 0.45 + rnd() * 0.3,
          0.12 * Math.exp(-r / 40), [255, 205 + 30 * rnd(), 130 + 60 * rnd()], [0, 220, 255]);
      }
      for (let k = 0; k < N_HII; k++) {                       // HII regions, pink star-forming knots
        const r = 90 + 480 * Math.pow(rnd(), 1.3);
        set(2, r, armTheta(r, arms()) + gauss() * 0.1, gauss() * 4, 1.6 + rnd() * 1.6, 0.9 + rnd() * 0.1, 0.95, 0.0,
          [255, 105 + 40 * rnd(), 185 + 30 * rnd()], [157, 0, 255]);
      }
      for (let k = 0; k < N_XR; k++) {                        // X-ray binaries / hot gas knots
        const near = rnd() < 0.55;
        const r = near ? Math.abs(gauss()) * 45 + 6 : 60 + 520 * Math.pow(rnd(), 1.5);
        const th = near ? rnd() * TAU : armTheta(r, arms()) + gauss() * 0.15;
        set(3, r, th, gauss() * 6, 1.8 + rnd() * 1.8, 0.2, 0.18, 0.95 + 0.05 * rnd(),
          [200, 220, 255], rnd() < 0.5 ? [0, 240, 255] : [157, 60, 255]);
      }
      for (let k = 0; k < N_HALO; k++) {                      // faint spherical halo
        const r = 80 + 520 * Math.pow(rnd(), 0.8), th = rnd() * TAU;
        set(1, r, th, gauss() * 140, 0.7 + rnd() * 0.5, 0.12 + rnd() * 0.18, 0.18, 0.0, [255, 225, 190], [90, 150, 255]);
      }
      /* cloud blobs: dust lanes, emission nebulae, hot X-ray gas */
      this.blobs = [];
      for (let k = 0; k < 420; k++) {
        const r = 60 + 520 * Math.pow(rnd(), 1.35), type = k % 7 === 0 ? 1 : (k % 5 === 0 ? 2 : 0);
        this.blobs.push({ r, th: armTheta(r, arms()) + gauss() * 0.13 + (type === 0 ? 0.18 : 0), h: gauss() * 5,
          s: 26 + rnd() * 52 + (type === 2 ? 22 : 0), type, a: 0.35 + rnd() * 0.65, om: 0.9 / Math.sqrt(r / 40) * 0.05,
          tint: rnd(), x: 0, y: 0, d: 1 });
      }
      /* background starfield: 3 warp layers */
      this.bg = [];
      const counts = [900, 600, 400];
      for (let L = 0; L < 3; L++) for (let k = 0; k < counts[L]; k++)
        this.bg.push({ L, ang: rnd() * TAU, z0: rnd(), spread: 0.35 + rnd() * 0.65, a: 0.25 + rnd() * 0.75, tw: rnd() * TAU, hue: rnd() });
      this.particleCount = N + this.bg.length;
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.25) * (this.quality || 1);
      const w = innerWidth, h = innerHeight;
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
      this.dpr = dpr; this.W = w; this.H = h;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.lo = 0.3; const gw = Math.ceil(w * this.lo), gh = Math.ceil(h * this.lo);
      if (!this.gc) { this.gc = document.createElement('canvas'); this.dc = document.createElement('canvas'); }
      this.gc.width = this.dc.width = gw; this.gc.height = this.dc.height = gh;
      this.gx = this.gc.getContext('2d'); this.dx = this.dc.getContext('2d');
    }

    /* ---- public API --------------------------------------------------------------- */
    setScroll(p) { this.target = clamp(p, 0, 1); }
    setWavelength(v) { this.waveTarget = clamp(v, 0, 3); }
    setThreat(p) { this.threat = clamp(p, 0, 1); }
    pulse(hex, strength = 1) { this.pulses.push({ hex, t: 0, s: strength }); }
    get wavelengthName() { return WAVES[Math.round(this.wave)]; }

    computeWeights() {
      const s = this.wave, tri = (c) => Math.max(0, 1 - Math.abs(s - c));
      const m = clamp(s - 2, 0, 1);
      this.weights = [tri(0) + m * 0.6, tri(1) + m * 0.6, Math.max(tri(2), m)];
      const [wv, wi, wx] = this.weights;
      const I = this.N;
      let maxv = 0;
      for (let k = 0; k < I; k++) {
        let R = 0, G = 0, B = 0;
        const bv = this.bv[k] * wv, bi = this.bi[k] * wi * (this.kind[k] === 2 ? 1 : 0.85), bx = this.bx[k] * wx;
        R += this.cvR[k] * bv + 255 * bi + this.cxR[k] * bx;
        G += this.cvG[k] * bv + (70 + 90 * this.bv[k]) * bi + this.cxG[k] * bx;
        B += this.cvB[k] * bv + (35 + 40 * (1 - this.bv[k])) * bi + this.cxB[k] * bx;
        R = Math.min(255, R); G = Math.min(255, G); B = Math.min(255, B);
        const q = ((R >> 5) << 6) | ((G >> 5) << 3) | (B >> 5);
        this.rgb[k] = q;
        maxv = Math.max(maxv, R, G, B);
        this._cr = this._cr || new Uint8Array(this.N * 3);
        this._cr[k * 3] = R; this._cr[k * 3 + 1] = G; this._cr[k * 3 + 2] = B;
      }
      const idx = Array.from({ length: I }, (_, k) => k).sort((a, b) => this.rgb[a] - this.rgb[b]);
      for (let k = 0; k < I; k++) this.order[k] = idx[k];
      this.bright = idx.filter((k) => (this.kind[k] === 2 || this.kind[k] === 3 || this.size[k] > 1.7) && (this._cr[k * 3] + this._cr[k * 3 + 1] + this._cr[k * 3 + 2]) > 180).slice(0, 360);
      this.dirty = false;
    }

    /* ---- frame -------------------------------------------------------------------- */
    frame(now) {
      if (!this.running) return;
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
      this._frames++;
      if (now - this._fpsT > 1000) {
        this.fps = this._frames * 1000 / (now - this._fpsT); this._frames = 0; this._fpsT = now;
        if (this.fps < 30 && this.quality > 0.45) { this.quality *= 0.8; this.resize(); }       // adaptive render scale
        else if (this.fps > 56 && this.quality < 1) { this.quality = Math.min(1, this.quality * 1.15); this.resize(); }
      }
      const pPrev = this.progress;
      this.progress += (this.target - this.progress) * (1 - Math.exp(-dt * 5.5));
      this.vel = (this.progress - pPrev) / Math.max(dt, 1e-3);
      if (Math.abs(this.wave - this.waveTarget) > 1e-3) { this.wave += (this.waveTarget - this.wave) * (1 - Math.exp(-dt * 7)); this.dirty = true; }
      else if (this.wave !== this.waveTarget) { this.wave = this.waveTarget; this.dirty = true; }
      if (this.dirty) this.computeWeights();
      this.draw(dt);
      const p = this.progress, z = 1000 * Math.pow(0.05, p);
      this.state = { progress: p, z, layer: p < 0.335 ? 1 : p < 0.665 ? 2 : 3, fps: this.fps, wave: this.wave };
      requestAnimationFrame((n) => this.frame(n));
    }

    draw(dt) {
      const ctx = this.ctx, W = this.W, H = this.H, cx = W / 2 + this.mx * -40, cy = H * 0.5 + this.my * -30;
      const p = this.progress, d = 1000 * Math.pow(0.05, p);
      const f = Math.min(W, H) * 0.78 + W * 0.05;
      const tilt = lerp(1.05, 0.45, smooth(p)), ct = Math.cos(tilt), st = Math.sin(tilt);
      const spin = this.t, yaw = this.mx * 0.25;
      const [wv, wi, wx] = this.weights;
      ctx.globalCompositeOperation = 'source-over';
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
      const tc = [Math.round(30 * wv + 60 * wi + 35 * wx), Math.round(25 * wv + 8 * wi + 12 * wx), Math.round(70 * wv + 40 * wi + 110 * wx)];
      bg.addColorStop(0, `rgb(${3 + tc[0] * 0.55 | 0},${4 + tc[1] * 0.55 | 0},${8 + tc[2] * 0.55 | 0})`);
      bg.addColorStop(1, '#030408');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      const vel = Math.abs(this.vel);
      const streak = clamp(vel * 1.1, 0, 0.5);

      /* background warp starfield -------------------------------------------------- */
      const loops = [0.8, 1.7, 3.2], drift = [0.012, 0.022, 0.04];
      const maxR = Math.hypot(W, H) * 0.62;
      ctx.lineCap = 'round';
      for (let k = 0; k < this.bg.length; k++) {
        const s = this.bg[k], L = s.L;
        const z = 1 - frac(s.z0 - (p * loops[L] * 2.0 + this.t * drift[L]));   // 0 = at camera, 1 = far
        const zz = Math.max(0.03, z);
        const r = maxR * s.spread * (1 - zz) / (zz * 2.2 + 0.12) * 0.55;
        if (r > maxR * 1.2) continue;
        const ang = s.ang + this.mx * 0.04 * (L + 1);
        const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
        const fade = smooth(clamp(r / 90, 0, 1)) * (0.55 + 0.45 * Math.sin(this.t * 1.7 + s.tw));
        const a = s.a * fade * (0.5 + 0.5 * (wv + wx * 0.6 + wi * 0.7));
        if (a < 0.02) continue;
        const col = wi > 0.5 ? '255,170,120' : wx > 0.5 ? (s.hue < 0.5 ? '120,230,255' : '190,130,255') : (s.hue < 0.3 ? '255,235,210' : '190,210,255');
        ctx.globalAlpha = Math.min(1, a);
        if (streak > 0.02) {
          const x0 = cx + Math.cos(ang) * r * (1 - streak * (0.4 + L * 0.35)), y0 = cy + Math.sin(ang) * r * (1 - streak * (0.4 + L * 0.35));
          ctx.strokeStyle = `rgb(${col})`; ctx.lineWidth = 0.6 + L * 0.5;
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x, y); ctx.stroke();
        } else {
          ctx.fillStyle = `rgb(${col})`; const sz = 0.7 + L * 0.55; ctx.fillRect(x, y, sz, sz);
        }
      }
      ctx.globalAlpha = 1;

      /* project the disk particles ------------------------------------------------- */
      const N = this.N;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw);
      for (let k = 0; k < N; k++) {
        const a = this.th[k] + spin * this.om[k] * 3.2;
        let x = Math.cos(a) * this.r[k], y = Math.sin(a) * this.r[k], z = this.h[k];
        const x2 = x * cyw - z * syw, z2 = x * syw + z * cyw;
        const y2 = y * ct - z2 * st, zc = y * st + z2 * ct;
        const depth = d + zc;
        if (depth < 6) { this.pd[k] = -1; continue; }
        const sc = f / depth;
        this.sx[k] = cx + x2 * sc; this.sy[k] = cy + y2 * sc; this.pd[k] = sc;
      }
      /* nebula / dust blobs -> two low-res offscreen layers (cheap fill-rate) --------- */
      const lo = this.lo, gx = this.gx, dxc = this.dx, gw = this.gc.width, gh = this.gc.height;
      gx.globalCompositeOperation = 'source-over'; gx.clearRect(0, 0, gw, gh); gx.globalCompositeOperation = 'lighter';
      dxc.clearRect(0, 0, gw, gh);
      const sp = cloudSprite;
      const put = (c, spr, b, rad, al) => { c.globalAlpha = Math.min(1, al); c.drawImage(spr, (b.x * lo) - rad, (b.y * lo) - rad * ct, rad * 2, rad * 2 * ct + 1.5); };
      for (let k = 0; k < this.blobs.length; k++) {
        const b = this.blobs[k];
        const a = b.th + spin * b.om * 3.2;
        const x = Math.cos(a) * b.r, y = Math.sin(a) * b.r, z = b.h;
        const x2 = x * cyw - z * syw, z2 = x * syw + z * cyw;
        const y2 = y * ct - z2 * st, zc = y * st + z2 * ct;
        const depth = d + zc;
        if (depth < 30) { b.d = -1; continue; }
        const sc = f / depth;
        b.x = cx + x2 * sc; b.y = cy + y2 * sc; b.d = sc;
        const rr = b.s * sc; if (rr > W * 1.2 || rr < 3) { b.d = -1; continue; }
        const rad = rr * lo, near = clamp(1.2 - rr / (W * 0.9), 0.12, 1);
        if (b.type === 0) {        // dust lane
          if (wv > 0.02) put(dxc, sp(6, 6, 14), b, rad, 0.5 * wv * b.a * near);
          if (wi > 0.02) put(gx, sp(255, 90 + 60 * b.tint | 0, 30), b, rad, 0.5 * wi * b.a * near);
          if (wx > 0.02) put(gx, sp(120, 40, 255), b, rad, 0.08 * wx * b.a * near);
        } else if (b.type === 1) { // emission nebula
          if (wv > 0.02) put(gx, sp(b.tint < 0.5 ? 255 : 90, b.tint < 0.5 ? 90 : 150, b.tint < 0.5 ? 190 : 255), b, rad, 0.4 * wv * b.a * near);
          if (wi > 0.02) put(gx, sp(255, 60, 30), b, rad, 0.5 * wi * b.a * near);
          if (wx > 0.02) put(gx, sp(0, 200, 255), b, rad, 0.16 * wx * b.a * near);
        } else {                   // hot gas
          if (wx > 0.02) put(gx, sp(157, 40, 255), b, rad, 0.36 * wx * b.a * near);
          if (wi > 0.02) put(gx, sp(255, 120, 60), b, rad, 0.22 * wi * b.a * near);
          if (wv > 0.02) put(gx, sp(120, 160, 255), b, rad, 0.14 * wv * b.a * near);
        }
      }
      gx.globalAlpha = 1; dxc.globalAlpha = 1;
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'lighter'; ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.gc, 0, 0, W, H);

      /* stars (bucket-sorted -> few fillStyle changes) ------------------------------ */
      let lastQ = -1;
      const cr = this._cr;
      for (let n = 0; n < N; n++) {
        const k = this.order[n], sc = this.pd[k];
        if (sc < 0) continue;
        const x = this.sx[k], y = this.sy[k];
        if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
        const q = this.rgb[k];
        if (q !== lastQ) { ctx.fillStyle = `rgb(${cr[k * 3]},${cr[k * 3 + 1]},${cr[k * 3 + 2]})`; lastQ = q; }
        const sz = clamp(this.size[k] * (0.7 + Math.min(sc, 3) * 0.5), 0.9, 3.4);
        ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz);
      }
      if (wv > 0.02) { ctx.globalCompositeOperation = 'source-over'; ctx.drawImage(this.dc, 0, 0, W, H); ctx.globalCompositeOperation = 'lighter'; }
      /* glow sprites on bright stars + relativistic streaks ------------------------- */
      const br = this.bright || [];
      for (let n = 0; n < br.length; n++) {
        const k = br[n], sc = this.pd[k];
        if (sc < 0) continue;
        const x = this.sx[k], y = this.sy[k];
        if (x < -30 || x > W + 30 || y < -30 || y > H + 30) continue;
        const R = cr[k * 3], G = cr[k * 3 + 1], B = cr[k * 3 + 2];
        const tw = 0.75 + 0.25 * Math.sin(this.t * 2 + k);
        const s = clamp(this.size[k] * (4 + Math.min(sc, 3) * 3), 6, 34);
        ctx.globalAlpha = 0.5 * tw * (1 - 0.6 * p);
        ctx.drawImage(glowSprite(R & 0xE0 | 16, G & 0xE0 | 16, B & 0xE0 | 16), x - s, y - s, s * 2, s * 2);
        if (streak > 0.03) {
          const dx = x - cx, dy = y - cy;
          ctx.globalAlpha = Math.min(0.32, streak * 0.7);
          ctx.strokeStyle = `rgb(${R},${G},${B})`; ctx.lineWidth = Math.min(3, 0.6 + sc * 0.5);
          ctx.beginPath(); ctx.moveTo(x - dx * streak * 0.9, y - dy * streak * 0.9); ctx.lineTo(x, y); ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      /* quasar core ------------------------------------------------------------------ */
      this.drawCore(ctx, cx, cy, f / d, ct, p, dt);

      /* pulses (stage events) --------------------------------------------------------- */
      for (let k = this.pulses.length - 1; k >= 0; k--) {
        const q = this.pulses[k]; q.t += dt;
        if (q.t > 1.6) { this.pulses.splice(k, 1); continue; }
        const e = q.t / 1.6, rr = e * Math.hypot(W, H) * 0.55;
        ctx.globalAlpha = (1 - e) * 0.55 * q.s; ctx.strokeStyle = q.hex; ctx.lineWidth = 2 + 10 * (1 - e);
        ctx.beginPath(); ctx.ellipse(cx, cy, rr, rr * Math.max(0.35, ct), 0, 0, TAU); ctx.stroke();
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }

    drawCore(ctx, cx, cy, sc, ct, p, dt) {
      const [wv, wi, wx] = this.weights;
      const base = 34 * sc;
      const R = Math.min(base, Math.min(this.W, this.H) * 0.62);
      const pulse = 0.88 + 0.12 * Math.sin(this.t * 2.3);
      const comp = 1 - 0.55 * clamp(wv + wi + wx - 1, 0, 1), k = clamp(1.0 - p * 0.8, 0.2, 0.9) * comp;        // keep the deep UI readable
      const layer = (r, g, b, rad, alpha) => {
        const gr = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
        gr.addColorStop(0, `rgba(${r},${g},${b},${alpha})`); gr.addColorStop(0.35, `rgba(${r},${g},${b},${alpha * 0.35})`);
        gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.fillStyle = gr; ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
      };
      ctx.globalCompositeOperation = 'lighter';
      if (wv > 0.01) layer(255, 215, 160, R * 3.0, 0.34 * wv * pulse * k);
      if (wi > 0.01) layer(255, 70, 40, R * 3.6, 0.36 * wi * pulse * k);
      if (wx > 0.01) { layer(157, 40, 255, R * 4.2, 0.28 * wx * k); layer(0, 240, 255, R * 1.8, 0.36 * wx * pulse * k); }
      if (this.threat > 0.05 && (wx > 0.05 || wi > 0.05)) layer(255, 42, 84, R * 3.0, 0.28 * this.threat * pulse * Math.max(wx, wi) * k);
      // relativistic jets
      const jl = R * (3 + 5 * Math.max(wx, 0.4)), jw = Math.max(2, R * 0.07);
      for (const dir of [-1, 1]) {
        const gr = ctx.createLinearGradient(cx, cy, cx, cy + dir * jl);
        const col = wx > wv ? '0,240,255' : wi > wv ? '255,110,60' : '170,200,255';
        gr.addColorStop(0, `rgba(${col},${0.34 * k})`); gr.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.moveTo(cx - jw, cy); ctx.lineTo(cx - jw * 0.2, cy + dir * jl); ctx.lineTo(cx + jw * 0.2, cy + dir * jl); ctx.lineTo(cx + jw, cy); ctx.fill();
      }
      // accretion disk rings
      ctx.lineWidth = Math.max(1, R * 0.035);
      for (let i = 0; i < 6; i++) {
        const rr = R * (0.35 + i * 0.16), a = (0.38 - i * 0.05) * k;
        ctx.strokeStyle = wx > 0.5 ? `rgba(${i % 2 ? '157,80,255' : '0,240,255'},${a})` : wi > 0.5 ? `rgba(255,${90 + i * 20},40,${a})` : `rgba(255,${200 - i * 10},${150 - i * 12},${a})`;
        ctx.beginPath(); ctx.ellipse(cx, cy, rr, rr * ct * 0.55, this.t * 0.08 * (i % 2 ? 1 : -1) * 0, 0, TAU); ctx.stroke();
      }
      // event horizon
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(cx, cy, R * 0.16, 0, TAU); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255,255,255,${0.4 * k})`; ctx.lineWidth = Math.max(1, R * 0.02);
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.18, 0, TAU); ctx.stroke();
    }
  }

  window.GalaxyEngine = GalaxyEngine;
  window.WAVELENGTHS = WAVES;
})();

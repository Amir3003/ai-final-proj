/* QUASAR-ARB · constellation.js — interactive DEX liquidity constellation + animated A* plasma beam */
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const LAYOUT = {   // normalised star-map positions
    USDC: [0.33, 0.52], ETH: [0.67, 0.5], WBTC: [0.5, 0.14], SOL: [0.12, 0.22], ARB: [0.14, 0.82],
    LINK: [0.5, 0.88], UNI: [0.88, 0.2], AAVE: [0.88, 0.8],
  };
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function heat(t) {          // blue -> amber -> crimson
    t = clamp(t, 0, 1);
    const stops = [[40, 90, 255], [255, 184, 0], [255, 42, 84]];
    const k = t * 2, i = Math.min(1, Math.floor(k)), f = k - i;
    return stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * f));
  }
  function radiation(t) {     // emerald -> violet -> crimson
    t = clamp(t, 0, 1);
    const stops = [[0, 255, 157], [157, 0, 255], [255, 42, 84]];
    const k = t * 2, i = Math.min(1, Math.floor(k)), f = k - i;
    return stops[i].map((v, j) => Math.round(v + (stops[i + 1][j] - v) * f));
  }

  class Constellation {
    constructor(canvas, tip) {
      this.c = canvas; this.ctx = canvas.getContext('2d'); this.tip = tip;
      this.t = 0; this.last = performance.now(); this.wave = 0;
      this.data = null; this.nodes = {}; this.edges = []; this.route = null; this.routeGlow = 0;
      this.anim = null; this.pulses = []; this.focus = null; this.hover = null; this.threat = 0;
      this.onStep = null; this.onSelect = null;
      this.resize(); addEventListener('resize', () => this.resize());
      canvas.addEventListener('pointermove', (e) => this.pointer(e));
      canvas.addEventListener('pointerleave', () => { this.hover = null; this.tip.style.opacity = 0; });
      canvas.addEventListener('click', (e) => this.click(e));
      requestAnimationFrame((n) => this.frame(n));
    }
    resize() {
      const r = this.c.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      this.W = r.width; this.H = r.height; this.c.width = r.width * dpr; this.c.height = r.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); this.layout();
    }
    layout() {
      const pad = 70;
      for (const [k, v] of Object.entries(LAYOUT)) this.nodes[k] = Object.assign(this.nodes[k] || {}, { id: k, x: pad + v[0] * (this.W - 2 * pad), y: 50 + v[1] * (this.H - 100) });
      this.buildEdges();
    }
    load(res) {
      this.data = res;
      for (const [k, v] of Object.entries(res.tokens)) Object.assign(this.nodes[k], { price: v.price, color: v.color, name: v.name });
      this.pools = res.pools; this.metrics = Object.fromEntries(res.pool_metrics.map((m) => [m.id, m]));
      this.buildEdges();
      const b = res.astar.best || res.astar.fallback_best;
      this.setRoute(b, res.profitable);
      this.threat = res.bayes.p_trap;
    }
    buildEdges() {
      if (!this.pools) return;
      const seen = {};
      this.edges = this.pools.map((p) => {
        const a = this.nodes[p.a], b = this.nodes[p.b];
        const key = [p.a, p.b].sort().join('-'); seen[key] = (seen[key] || 0) + 1;
        const n = seen[key] - 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        const off = len * (0.07 + n * 0.0) * (n % 2 ? -1 : 1) * (n ? 1.4 : 1);
        return { p, a, b, cx: mx - dy / len * off, cy: my + dx / len * off, flow: Math.random(), speed: 0.12 + Math.random() * 0.1 };
      });
      this.edgeById = Object.fromEntries(this.edges.map((e) => [e.p.id, e]));
    }
    setWave(v) { this.wave = v; }
    weights() {
      const s = this.wave, tri = (c) => Math.max(0, 1 - Math.abs(s - c)), m = clamp(s - 2, 0, 1);
      return [Math.min(1, tri(0) + m), Math.min(1, tri(1) + m), Math.max(tri(2), m)];
    }
    setRoute(best, profitable) {
      this.routeOK = profitable;
      if (!best) { this.route = null; return; }
      this.route = { tokens: best.route, pools: best.pools, legs: best.legs };
      this.routeGlow = 0;
    }
    pt(e, t) {
      const u = 1 - t;
      return [u * u * e.a.x + 2 * u * t * e.cx + t * t * e.b.x, u * u * e.a.y + 2 * u * t * e.cy + t * t * e.b.y];
    }
    legPt(pid, from, t) {
      const e = this.edgeById[pid]; const tt = e.a.id === from ? t : 1 - t; return this.pt(e, tt);
    }

    /* ---- A* animation --------------------------------------------------------------- */
    playAStar(res, speed = 1) {
      return new Promise((resolve) => {
        const steps = res.astar.trace.filter((s) => s.event === 'EXPAND' || s.event === 'GOAL' || s.event === 'ROOT_PRUNED');
        this.routeGlow = 0; this.expanded = new Set(); this.visited = [];
        this.anim = { steps, i: -1, next: 0, speed, done: resolve, res, phase: 'search' };
      });
    }
    stopAnim() { if (this.anim) { const d = this.anim.done; this.anim = null; d && d(); } }
    advance(dt) {
      const a = this.anim; if (!a) return;
      if (a.phase === 'search') {
        a.next -= dt * 1000 * a.speed;
        if (a.next > 0) return;
        a.i++;
        if (a.i >= a.steps.length) { a.phase = 'beam'; a.beamT = 0; return; }
        const s = a.steps[a.i];
        a.next = 520 * (a.steps.length > 14 ? 14 / a.steps.length : 1) + 150;
        if (this.onStep) this.onStep(s, a.i);
        if (s.event === 'EXPAND') {
          const from = s.tokens[s.tokens.length - 1];
          this.visited.push(from);
          for (const ch of s.children) {
            const to = ch.path.split('→').pop();
            this.pulses.push({ pool: ch.pool, from, to, t: 0, kept: ch.kept, speed: 1.1 });
          }
          this.pulses.push({ ring: from, t: 0 });
        }
      } else if (a.phase === 'beam') {
        a.beamT += dt * a.speed;
        this.routeGlow = Math.min(1, a.beamT / 1.3);
        if (a.beamT > 1.5) { this.anim = null; a.done && a.done(); }
      }
    }

    /* ---- interaction ----------------------------------------------------------------- */
    local(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
    hit(x, y) {
      for (const n of Object.values(this.nodes)) if (Math.hypot(n.x - x, n.y - y) < 24) return { type: 'node', n };
      let best = null, bd = 9;
      for (const e of this.edges || []) for (let i = 0; i <= 20; i++) {
        const [px, py] = this.pt(e, i / 20), d = Math.hypot(px - x, py - y);
        if (d < bd) { bd = d; best = { type: 'edge', e }; }
      }
      return best;
    }
    pointer(e) {
      const [x, y] = this.local(e), h = this.hit(x, y); this.hover = h;
      if (!h) { this.tip.style.opacity = 0; this.c.style.cursor = 'default'; return; }
      this.c.style.cursor = 'pointer';
      let html;
      if (h.type === 'node') {
        const n = h.n; const deg = this.pools.filter((p) => p.a === n.id || p.b === n.id).length;
        html = `<b style="color:${n.color}">${n.id}</b> · ${n.name}<br>oracle <b>$${n.price.toLocaleString()}</b><br>${deg} wormhole conduits`;
      } else {
        const p = h.e.p, m = this.metrics[p.id];
        html = `<b style="color:${p.color}">${p.protocol}</b> ${p.a}/${p.b} <span class="dim">${p.id}</span><br>fee ${p.fee_pct}% · TVL $${(p.tvl_usd / 1e6).toFixed(1)}M<br>` +
          `slippage <b>${m.slippage_pct.toFixed(3)}%</b> · MEV radiation <b>${(m.mev_exposure * 100).toFixed(0)}%</b><br>gas $${m.gas_usd.toFixed(2)} · mispricing ${p.dev_bps > 0 ? '+' : ''}${p.dev_bps.toFixed(0)} bps`;
      }
      this.tip.innerHTML = html;
      const r = this.c.getBoundingClientRect();
      this.tip.style.left = Math.min(x + 16, r.width - 230) + 'px'; this.tip.style.top = (y + 14) + 'px'; this.tip.style.opacity = 1;
    }
    click(e) {
      const [x, y] = this.local(e), h = this.hit(x, y);
      this.focus = h && h.type === 'node' ? (this.focus === h.n.id ? null : h.n.id) : null;
      if (this.onSelect) this.onSelect(this.focus);
    }

    /* ---- render ------------------------------------------------------------------------ */
    frame(now) {
      const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.t += dt;
      this.advance(dt);
      if (this.data) this.draw(dt);
      requestAnimationFrame((n) => this.frame(n));
    }
    edgeColor(e, w) {
      const m = this.metrics[e.p.id];
      const vis = hexRgb(e.p.color), ir = heat(m.slippage_pct / 2.2), xr = radiation(m.mev_exposure);
      return { vis, ir, xr, m };
    }
    strokeEdge(ctx, e, col, alpha, width, dash) {
      ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${alpha})`; ctx.lineWidth = width;
      ctx.setLineDash(dash || []);
      ctx.beginPath(); ctx.moveTo(e.a.x, e.a.y); ctx.quadraticCurveTo(e.cx, e.cy, e.b.x, e.b.y); ctx.stroke();
    }
    draw(dt) {
      const ctx = this.ctx, W = this.W, H = this.H, [wv, wi, wx] = this.weights();
      ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter';
      // orbit rings behind the stars
      ctx.strokeStyle = 'rgba(0,240,255,0.05)'; ctx.lineWidth = 1;
      for (let i = 1; i <= 3; i++) { ctx.beginPath(); ctx.ellipse(W / 2, H / 2, W * 0.12 * i, H * 0.17 * i, 0, 0, TAU); ctx.stroke(); }
      const dim = this.focus ? 0.28 : 1;
      for (const e of this.edges) {
        const c = this.edgeColor(e), foc = !this.focus || e.a.id === this.focus || e.b.id === this.focus;
        const k = foc ? 1 : dim, onRoute = this.route && this.route.pools.includes(e.p.id);
        const wid = 0.8 + Math.log10(e.p.tvl_usd / 1e6 + 1) * 1.3;
        if (wv > 0.02) this.strokeEdge(ctx, e, c.vis, 0.5 * wv * k, wid * (0.8 + 0.4 * wv));
        if (wi > 0.02) { this.strokeEdge(ctx, e, c.ir, 0.2 * wi * k, 8 + c.m.slippage_pct * 6); this.strokeEdge(ctx, e, c.ir, 0.85 * wi * k, 1.2 + c.m.slippage_pct * 2.4); }
        if (wx > 0.02) {
          const speed = this.t * 22 * (0.4 + c.m.mev_exposure);
          this.strokeEdge(ctx, e, c.xr, 0.14 * wx * k, 7 + c.m.mev_exposure * 16);
          ctx.lineDashOffset = -speed; this.strokeEdge(ctx, e, c.xr, (0.35 + 0.6 * c.m.mev_exposure) * wx * k, 1.4 + c.m.mev_exposure * 2.4, [2 + 8 * c.m.mev_exposure, 6]);
          ctx.lineDashOffset = 0;
        }
        ctx.setLineDash([]);
        // flowing liquidity motes
        e.flow = (e.flow + dt * e.speed) % 1;
        for (let m = 0; m < 3; m++) {
          const t = (e.flow + m / 3) % 1, [x, y] = this.pt(e, t);
          const col = wx > wv && wx > wi ? c.xr : wi > wv ? c.ir : c.vis;
          ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${0.75 * k})`; ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
        }
        if (onRoute && this.routeOK === false) { /* loss route is only drawn faintly */ }
      }

      // search pulses
      for (let i = this.pulses.length - 1; i >= 0; i--) {
        const p = this.pulses[i]; p.t += dt;
        if (p.ring) {
          const n = this.nodes[p.ring], e = p.t / 0.9;
          if (e > 1) { this.pulses.splice(i, 1); continue; }
          ctx.strokeStyle = `rgba(0,240,255,${1 - e})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(n.x, n.y, 16 + e * 46, 0, TAU); ctx.stroke(); continue;
        }
        const e = p.t / 0.8;
        if (e > 1.1) { this.pulses.splice(i, 1); continue; }
        const [x, y] = this.legPt(p.pool, p.from, Math.min(1, e));
        const col = p.kept ? '0,240,255' : '255,42,84', s = 14 * (1 - Math.abs(e - 0.5) * 0.8);
        ctx.fillStyle = `rgba(${col},0.9)`; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, TAU); ctx.fill();
        const g = ctx.createRadialGradient(x, y, 0, x, y, s); g.addColorStop(0, `rgba(${col},0.55)`); g.addColorStop(1, `rgba(${col},0)`);
        ctx.fillStyle = g; ctx.fillRect(x - s, y - s, s * 2, s * 2);
      }

      // winning route: plasma beam
      if (this.route && (this.routeGlow > 0 || !this.anim)) {
        const glow = this.anim ? this.routeGlow : 1, ok = this.routeOK !== false;
        const hot = ok ? [255, 184, 0] : [255, 42, 84], core = ok ? [255, 255, 235] : [255, 190, 200];
        const legs = this.route.legs; const nL = legs.length;
        for (let li = 0; li < nL; li++) {
          const lg = legs[li], e = this.edgeById[lg.pool];
          const seg = clamp(glow * nL - li, 0, 1); if (seg <= 0) continue;
          const steps = 36, upto = Math.floor(steps * seg);
          const draw = (w, col, a) => {
            ctx.strokeStyle = `rgba(${col[0]},${col[1]},${col[2]},${a})`; ctx.lineWidth = w; ctx.lineCap = 'round';
            ctx.beginPath();
            for (let s = 0; s <= upto; s++) { const [x, y] = this.legPt(lg.pool, lg.from, s / steps); s ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
            ctx.stroke();
          };
          draw(15, hot, 0.12 + 0.05 * Math.sin(this.t * 6)); draw(7, hot, 0.4); draw(2.6, core, 0.95);
          // comet head cycling around the loop
          const th = (this.t * 0.55 + li / nL) % 1, [hx, hy] = this.legPt(lg.pool, lg.from, th);
          const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 16); g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.4, `rgba(${hot[0]},${hot[1]},${hot[2]},0.5)`); g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g; ctx.fillRect(hx - 16, hy - 16, 32, 32);
          // leg label
          if (seg > 0.99) {
            const [lx, ly] = this.legPt(lg.pool, lg.from, 0.5);
            ctx.globalCompositeOperation = 'source-over'; ctx.font = '10px "JetBrains Mono",monospace'; ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.fillText(`${lg.pool} · ${lg.price_impact_pct.toFixed(2)}% imp`, lx + 6, ly - 8); ctx.globalCompositeOperation = 'lighter';
          }
        }
      }

      // star systems
      ctx.globalCompositeOperation = 'lighter';
      const routeSet = new Set(this.route ? this.route.tokens : []);
      for (const n of Object.values(this.nodes)) {
        if (!n.color) continue;
        const [r, g, b] = hexRgb(n.color), foc = !this.focus || n.id === this.focus ? 1 : dim;
        const adj = this.pools.filter((p) => p.a === n.id || p.b === n.id);
        const avgSlip = adj.reduce((s, p) => s + this.metrics[p.id].slippage_pct, 0) / adj.length;
        const avgMev = adj.reduce((s, p) => s + this.metrics[p.id].mev_exposure, 0) / adj.length;
        let halo = 26 + (routeSet.has(n.id) ? 10 : 0);
        halo += wi * Math.min(30, avgSlip * 16) + wx * avgMev * 30;
        const hc = wx > wi && wx > wv ? radiation(avgMev) : wi > wv ? heat(avgSlip / 1.8) : [r, g, b];
        const gr = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, halo);
        gr.addColorStop(0, `rgba(${hc[0]},${hc[1]},${hc[2]},${0.55 * foc})`); gr.addColorStop(1, `rgba(${hc[0]},${hc[1]},${hc[2]},0)`);
        ctx.fillStyle = gr; ctx.fillRect(n.x - halo, n.y - halo, halo * 2, halo * 2);
        ctx.fillStyle = `rgba(${r},${g},${b},${foc})`; ctx.beginPath(); ctx.arc(n.x, n.y, 6.5, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgba(255,255,255,${0.9 * foc})`; ctx.beginPath(); ctx.arc(n.x, n.y, 2.6, 0, TAU); ctx.fill();
        for (let o = 0; o < adj.length; o++) {      // orbiting pool-planets
          const ang = this.t * (0.5 + o * 0.08) + o * TAU / adj.length, rr = 14 + (o % 3) * 4;
          ctx.fillStyle = `${adj[o].color}${foc === 1 ? 'cc' : '44'}`;
          ctx.beginPath(); ctx.arc(n.x + Math.cos(ang) * rr, n.y + Math.sin(ang) * rr * 0.6, 1.8, 0, TAU); ctx.fill();
        }
        if (this.visited && this.visited.includes(n.id) && this.anim) {
          ctx.strokeStyle = 'rgba(0,240,255,0.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(n.x, n.y, 12, 0, TAU); ctx.stroke();
        }
        if (this.hover && this.hover.type === 'node' && this.hover.n === n) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(n.x, n.y, 17, 0, TAU); ctx.stroke(); }
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = '700 12px Orbitron, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = `rgba(230,250,255,${foc})`;
        ctx.fillText(n.id, n.x, n.y + 31);
        ctx.font = '10px "JetBrains Mono",monospace'; ctx.fillStyle = `rgba(150,200,220,${0.9 * foc})`;
        const wlab = wi > 0.5 && wi >= wx ? `slip ${avgSlip.toFixed(2)}%` : wx > 0.5 ? `MEV ${(avgMev * 100).toFixed(0)}%` : `$${n.price < 10 ? n.price.toFixed(2) : n.price.toLocaleString()}`;
        ctx.fillText(wlab, n.x, n.y + 44);
        ctx.globalCompositeOperation = 'lighter';
      }
      ctx.globalCompositeOperation = 'source-over'; ctx.textAlign = 'left';
    }
  }
  window.Constellation = Constellation;
})();

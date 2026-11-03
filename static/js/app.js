/* QUASAR-ARB · app.js — API binding, KaTeX math, telemetry panels, Quantum Trace sequencer */
(function () {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const money = (x, d = 2) => (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (x, d = 2) => (x * 100).toFixed(d) + '%';
  const f6 = (x) => (Math.abs(x) < 1e-12 ? '0.000000' : x.toFixed(6));
  const sgn = (x, d = 5) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(d);
  const ACTION_SHORT = { EXECUTE_FLASH_SWAP: 'EXECUTE', PRIVATE_RPC_PROTECT: 'PRIVATE RPC', ABORT_AND_WAIT: 'ABORT & WAIT' };
  const SENSOR_ORDER = ['gas_priority_spike', 'mev_bot_signature', 'pool_imbalance_shock'];

  const QA = (window.QA = { res: null, scenario: 'alpha', market: 'alpha', busy: false, trace: { state: 'idle' }, speed: 1, muted: false });

  /* ---------- helpers ------------------------------------------------------------------- */
  function tex(el, src) {
    try { window.katex.render(src, el, { throwOnError: false, displayMode: false }); }
    catch (e) { el.textContent = src.replace(/\\[a-z]+|[{}]/g, ' '); }
  }
  let actx = null;
  function sfx(freq = 440, dur = 0.09, type = 'sine', vol = 0.04, slide = 0) {
    if (QA.muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.type = type; o.frequency.setValueAtTime(freq, t); if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* audio unavailable */ }
  }
  const logEl = $('#mathlog');
  function log(line, cls = '') {
    const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = line + '\n';
    logEl.appendChild(s); while (logEl.childNodes.length > 500) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------- engines ------------------------------------------------------------------- */
  const galaxy = (window.galaxy = new GalaxyEngine($('#galaxy')));
  const cons = (window.cons = new Constellation($('#constellation'), $('#ctip')));
  $('#pcount').textContent = galaxy.particleCount.toLocaleString();

  function maxScroll() { return Math.max(1, document.documentElement.scrollHeight - innerHeight); }
  function onScroll() { galaxy.setScroll(scrollY / maxScroll()); }
  addEventListener('scroll', onScroll, { passive: true }); onScroll();

  function equalizeLayers() {
    const L = $$('.layer'); L.forEach((l) => (l.style.minHeight = ''));
    const h = Math.max(innerHeight, ...L.map((l) => l.offsetHeight));
    L.forEach((l) => (l.style.minHeight = h + 'px')); onScroll();
  }
  addEventListener('resize', equalizeLayers);

  const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) e.target.classList.add('visible'); }), { threshold: 0.08 });
  $$('.layer').forEach((l) => io.observe(l));

  let scrolling = null;
  function scrollToY(y, ms = 1500) {
    return new Promise((res) => {
      if (scrolling) cancelAnimationFrame(scrolling);
      const y0 = scrollY, t0 = performance.now(), dy = y - y0;
      const step = (now) => {
        const t = clamp((now - t0) / ms, 0, 1), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        scrollTo(0, y0 + dy * e);
        if (t < 1) scrolling = requestAnimationFrame(step); else { scrolling = null; res(); }
      };
      scrolling = requestAnimationFrame(step);
    });
  }
  const layerY = (k) => ((k - 0.5) / 3) * maxScroll();
  function gotoLayer(k, ms) { return scrollToY(layerY(k), ms); }
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => gotoLayer(+b.dataset.goto, 1200)));

  /* ---------- wavelength slider ------------------------------------------------------------ */
  const slider = $('#wave-slider');
  const LEGENDS = [
    [['Uniswap V3', '#FF4FD8'], ['Curve', '#FFB800'], ['Balancer', '#4DA3FF'], ['SushiSwap', '#00FF9D']],
    [['low slippage', '#285AFF'], ['mid', '#FFB800'], ['high slippage heat', '#FF2A54']],
    [['clean', '#00FF9D'], ['probed', '#9D00FF'], ['MEV radiation', '#FF2A54']],
  ];
  function setWave(v) {
    v = clamp(+v, 0, 3); slider.value = v; galaxy.setWavelength(v); cons.setWave(v);
    const near = Math.round(v);
    $$('#spec-labels button').forEach((b) => b.classList.toggle('active', +b.dataset.w === near));
    const sets = near === 3 ? [0, 1, 2] : [near];
    $('#legend').innerHTML = sets.flatMap((s) => LEGENDS[s]).map(([n, c]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
    document.body.dataset.wave = ['visible', 'infrared', 'xray', 'multi'][near];
  }
  slider.addEventListener('input', () => setWave(slider.value));
  $$('#spec-labels button').forEach((b) => b.addEventListener('click', () => setWave(b.dataset.w)));
  setWave(0);

  /* ---------- API ----------------------------------------------------------------------------- */
  function readDeck() {
    return {
      capital: +$('#in-capital').value, prior: +$('#in-prior').value, gas_gwei: +$('#in-gas').value, gamma: +$('#in-gamma').value,
      dislocation: +$('#in-disl').value, sensors: Object.fromEntries(SENSOR_ORDER.map((k) => [k, $('#sn-' + k).checked])),
    };
  }
  function writeDeck(p) {
    $('#in-capital').value = p.capital; $('#in-prior').value = p.prior; $('#in-gas').value = p.gas_gwei; $('#in-gamma').value = p.gamma; $('#in-disl').value = p.dislocation;
    SENSOR_ORDER.forEach((k) => ($('#sn-' + k).checked = !!p.sensors[k])); deckLabels();
  }
  function deckLabels() {
    $('#v-capital').textContent = money(+$('#in-capital').value, 0); $('#v-prior').textContent = (+$('#in-prior').value).toFixed(2);
    $('#v-gas').textContent = $('#in-gas').value + ' gwei'; $('#v-gamma').textContent = (+$('#in-gamma').value).toFixed(2); $('#v-disl').textContent = (+$('#in-disl').value).toFixed(1);
  }
  async function run(scenario, { quiet = false } = {}) {
    QA.busy = true; document.body.dataset.busy = '1';
    const body = scenario === 'delta' ? Object.assign({ scenario: 'delta', market: QA.market }, readDeck()) : { scenario };
    const r = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) { QA.busy = false; document.body.dataset.busy = '0'; throw new Error('API ' + r.status); }
    const res = await r.json();
    QA.scenario = scenario; QA.res = res; if (scenario !== 'delta') QA.market = res.params.market;
    render(res);
    QA.busy = false; document.body.dataset.busy = '0'; document.body.dataset.ready = '1';
    if (!quiet) log(`» ${res.scenario.name} → ${res.astar.best ? res.astar.best.route.join('→') : 'no cycle'} | p_trap=${pct(res.bayes.p_trap)} | ${res.mdp.recommended_action}`, 'st');
    return res;
  }
  $$('.scn').forEach((b) => b.addEventListener('click', () => { sfx(520, 0.07, 'triangle'); run(b.dataset.scenario); }));
  $('#btn-run').addEventListener('click', () => { sfx(660, 0.08, 'square', 0.025); run(QA.scenario); });
  let deckTimer = null;
  $$('#panel-deck input').forEach((i) => i.addEventListener('input', () => {
    deckLabels(); clearTimeout(deckTimer);
    if (QA.scenario !== 'delta') { QA.market = QA.res ? QA.res.params.market : 'alpha'; }
    deckTimer = setTimeout(() => run('delta'), 160);
  }));

  /* ---------- rendering -------------------------------------------------------------------------- */
  function rubricCard(title, rub) {
    const inp = Object.entries(rub.input).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' ? +v.toPrecision(6) : v}`).join('\n');
    const out = rub.output ? Object.entries(rub.output).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' ? +v.toPrecision(6) : v}`).join('\n') : '—';
    return `<div class="rcard"><h4>${title}</h4><dl><dt>INPUT</dt><dd>${esc(inp)}</dd><dt>KEY CALCULATION STEPS</dt><dd><ol>${rub.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol></dd><dt>OUTPUT</dt><dd>${esc(out)}</dd><dt>ONE-SENTENCE EXPLANATION</dt><dd>${esc(rub.explanation)}</dd></dl></div>`;
  }
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  function render(res) {
    const P = res.params, a = res.astar, b = res.bayes, m = res.mdp, ex = res.execution;
    const best = a.best || a.fallback_best;
    $$('.scn').forEach((s) => s.classList.toggle('active', s.dataset.scenario === P.scenario));
    writeDeck(P);
    $('#kpi-scn').textContent = res.scenario.short;
    $('#tel-route').textContent = best ? best.route.join('→') : 'none';
    const pe = $('#tel-profit'); pe.textContent = best ? money(res.profitable ? best.profit_usd : best.profit_usd) : '$0.00'; pe.className = 'num ' + (best && best.profit_usd > 0 ? 'pos' : 'neg');
    $('#tel-ptrap').textContent = pct(b.p_trap); $('#tel-action').textContent = ACTION_SHORT[m.recommended_action];
    galaxy.setThreat(b.p_trap);
    cons.load(res);
    renderAstar(res, best); renderBayes(res); renderMdp(res); renderExec(res, best);
    $('#rubric-body').innerHTML = rubricCard('ALGORITHM 1 · A* / BFS INFORMED GRAPH SEARCH', a.rubric) + rubricCard('ALGORITHM 2 · EXACT BAYESIAN INFERENCE', b.rubric) + rubricCard('ALGORITHM 3 · MDP (EU + BELLMAN VALUE ITERATION)', m.rubric);
    $('#inspect-astar').innerHTML = rubricCard('A* RUBRIC CARD', a.rubric);
    $('#inspect-bayes').innerHTML = rubricCard('BAYES RUBRIC CARD', b.rubric);
    $('#inspect-mdp').innerHTML = rubricCard('MDP RUBRIC CARD', m.rubric);
    requestAnimationFrame(equalizeLayers);
  }

  function renderAstar(res, best) {
    const a = res.astar, bfs = res.bfs;
    const rl = $('#route-line');
    if (best) {
      rl.innerHTML = best.route.map((t, i) => `<span class="tk" style="color:${res.tokens[t].color}">${t}</span>${i < best.route.length - 1 ? '<span class="ar">▸</span>' : ''}`).join('') + (res.profitable ? '' : '<span class="loss">NO PROFITABLE CYCLE · least-loss shown</span>');
    } else rl.innerHTML = '<span class="loss">NO CYCLE</span>';
    $('#a-profit').textContent = best ? money(best.profit_usd) : '—'; $('#a-bps').textContent = best ? best.profit_bps.toFixed(1) + ' bps' : '—';
    $('#a-gas').textContent = best ? money(best.gas_total_usd) : '—'; $('#a-hops').textContent = best ? best.hops : '—';
    const mx = Math.max(a.expanded, bfs.expanded, 1);
    $('#vs-bars').innerHTML = `<div class="vs-row"><span>A* expanded</span><div class="vs-track"><div class="vs-bar" id="bar-a" style="background:var(--cyan);box-shadow:0 0 10px var(--cyan)"></div></div><b id="tel-astar-exp" class="num">${a.expanded}</b></div>
      <div class="vs-row"><span>BFS expanded</span><div class="vs-track"><div class="vs-bar" id="bar-b" style="background:var(--crimson)"></div></div><b id="tel-bfs-exp" class="num">${bfs.expanded}</b></div>`;
    requestAnimationFrame(() => { $('#bar-a').style.width = (a.expanded / mx * 100) + '%'; $('#bar-b').style.width = (bfs.expanded / mx * 100) + '%'; });
    tex($('#f-astar'), String.raw`w(u\!\to\! v)=-\ln r_{\mathrm{eff}},\quad f(n)=g(n)+h(n),\quad h(n,k)=-\ln\!\Big(\max_{\le k\text{ hops}}\prod \rho_{\text{spot}}\Big)`);
    const tb = $('#trace-table tbody'); tb.innerHTML = '';
    for (const t of a.trace) {
      const tr = document.createElement('tr'); tr.dataset.step = t.step;
      if (t.event === 'GOAL') tr.className = 'goal'; if (t.event === 'ROOT_PRUNED') tr.className = 'root';
      const top = t.open_set && t.open_set[0];
      tr.innerHTML = `<td>${t.event === 'GOAL' ? '★' : t.event === 'ROOT_PRUNED' ? '✕' : t.step}</td><td>${esc(t.path)}</td><td>${sgn(t.g)}</td><td>${sgn(t.h)}</td><td>${sgn(t.f)}</td><td>${t.open_size ?? '—'}</td><td>${top ? esc(top.path) + ' (' + sgn(top.f, 4) + ')' : t.event === 'ROOT_PRUNED' ? 'f>0 ⇒ no profitable cycle' : '—'}</td>`;
      tb.appendChild(tr);
    }
    const lb = $('#legs-table tbody'); lb.innerHTML = '';
    for (const l of (best ? best.legs : [])) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${l.from}→${l.to}</td><td>${l.pool} ${esc(l.protocol)}</td><td>${l.amount_in.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td><td>${l.amount_out_net.toLocaleString('en-US', { maximumFractionDigits: 4 })}</td><td>${l.price_impact_pct.toFixed(3)}%</td><td>${money(l.gas_usd)}</td><td>${sgn(l.weight)}</td>`;
      lb.appendChild(tr);
    }
    $('#why-astar').textContent = a.explanation;
  }

  function renderBayes(res) {
    const b = res.bayes;
    $('#tel-prior').textContent = pct(b.prior_h1); $('#b-l1').textContent = f6(b.likelihood_h1); $('#b-l0').textContent = f6(b.likelihood_h0);
    $('#tel-marginal').textContent = f6(b.marginal); setGauge(b.p_trap);
    const vp = $('#verdict-pill'); vp.textContent = b.verdict === 'HOSTILE' ? 'HOSTILE MEMPOOL' : 'CLEAN WINDOW'; vp.className = 'pill ' + (b.verdict === 'HOSTILE' ? 'bad' : 'good');
    tex($('#f-bayes'), String.raw`P(H_1\mid E)=\frac{P(E\mid H_1)\,P(H_1)}{P(E)}=\frac{${f6(b.likelihood_h1)}\times${b.prior_h1.toFixed(4)}}{${f6(b.marginal)}}=\mathbf{${b.p_trap.toFixed(4)}}`);
    const tb = $('#seq-table tbody'); tb.innerHTML = '';
    if (!b.sequential.length) tb.innerHTML = '<tr><td colspan="7">no sensor observed — posterior = prior</td></tr>';
    for (const s of b.sequential) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${s.sensor}</td><td style="color:${s.reading === 'FIRED' ? 'var(--crimson)' : 'var(--emerald)'}">${s.reading}</td><td>${s.p_e_given_h1.toFixed(4)}</td><td>${s.p_e_given_h0.toFixed(4)}</td><td>${s.likelihood_ratio.toFixed(3)}</td><td>${s.p_e.toFixed(4)}</td><td>${s.prior.toFixed(4)}→<b>${s.posterior.toFixed(4)}</b></td>`;
      tb.appendChild(tr);
    }
    drawChain(b, b.sequential.length);
    $('#sensor-list').innerHTML = SENSOR_ORDER.map((k) => {
      const s = b.sensors[k], on = b.readings[k]; return `<div class="sensor ${on ? 'fired' : ''}" data-sensor="${k}"><span class="led"></span><div><b>${s.label}</b><small>${esc(on ? s.detail_on : s.detail_off)}</small></div><em>TPR ${s.p_on_h1} · FPR ${s.p_on_h0}</em></div>`;
    }).join('');
    $('#waves').innerHTML = SENSOR_ORDER.map((k) => `<div class="wl">${b.sensors[k].label}</div><svg viewBox="0 0 300 30" preserveAspectRatio="none"><path id="wv-${k}" fill="none" stroke-width="1.6"/></svg>`).join('');
    $('#why-bayes').textContent = b.explanation;
  }
  function setGauge(p) {
    const fg = $('#gauge-fg'); fg.style.strokeDashoffset = 314 * (1 - p);
    const c = p > 0.5 ? 'var(--crimson)' : p > 0.2 ? 'var(--gold)' : 'var(--emerald)'; fg.style.stroke = c; fg.style.color = c;
    $('#b-post').textContent = pct(p, 1);
  }
  function drawChain(b, upto) {
    const svg = $('#chain'), W = 640, H = 170, pad = 34;
    const pts = [{ l: 'prior', p: b.prior_h1 }].concat(b.sequential.map((s) => ({ l: s.sensor.replace('Known_', '').replace('_', ' ').slice(0, 15) + (s.reading === 'FIRED' ? ' ▲' : ' ▽'), p: s.posterior })));
    const n = pts.length, xs = (i) => (n === 1 ? W / 2 : pad + i * (W - 2 * pad - 20) / (n - 1)), ys = (p) => H - 28 - p * (H - 56);
    let h = `<defs><linearGradient id="ga" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF2A54" stop-opacity=".45"/><stop offset="1" stop-color="#FF2A54" stop-opacity="0"/></linearGradient></defs>`;
    for (const t of [0, .25, .5, .75, 1]) h += `<line x1="${pad - 8}" x2="${W - 8}" y1="${ys(t)}" y2="${ys(t)}" stroke="rgba(0,240,255,${t === .5 ? .35 : .1})" ${t === .5 ? 'stroke-dasharray="4 4"' : ''}/><text x="2" y="${ys(t) + 3}" fill="#7f9bb0" font-size="9" font-family="monospace">${(t * 100) | 0}%</text>`;
    const vis = pts.slice(0, upto + 1);
    const d = vis.map((q, i) => `${i ? 'L' : 'M'}${xs(i)},${ys(q.p)}`).join(' ');
    h += `<path d="${d} L${xs(vis.length - 1)},${ys(0)} L${xs(0)},${ys(0)}Z" fill="url(#ga)"/><path d="${d}" fill="none" stroke="#FF2A54" stroke-width="2.4" style="filter:drop-shadow(0 0 5px #FF2A54)"/>`;
    vis.forEach((q, i) => { h += `<circle cx="${xs(i)}" cy="${ys(q.p)}" r="5" fill="#030408" stroke="#00F0FF" stroke-width="2"/><text x="${xs(i)}" y="${ys(q.p) - 10}" fill="#fff" font-size="11" text-anchor="middle" font-family="monospace">${(q.p * 100).toFixed(1)}%</text><text x="${xs(i)}" y="${H - 8}" fill="#7f9bb0" font-size="9" text-anchor="middle" font-family="monospace">${esc(q.l)}</text>`; });
    svg.innerHTML = h;
  }

  function colorQ(v, mx) { const k = clamp(Math.abs(v) / (mx || 1), 0, 1); return v >= 0 ? `rgba(0,255,157,${0.06 + 0.4 * k})` : `rgba(255,42,84,${0.06 + 0.4 * k})`; }
  function renderMdp(res) {
    const m = res.mdp, A = m.actions, S = Object.keys(m.Q);
    $('#m-b0').textContent = m.belief[0].toFixed(4); $('#m-b1').textContent = m.belief[1].toFixed(4); $('#tel-iter').textContent = m.iterations; $('#m-gamma').textContent = m.params.gamma;
    const mx = Math.max(...S.flatMap((s) => A.map((a) => Math.abs(m.Q[s][a]))), 1);
    $('#qmat thead').innerHTML = `<tr><th>state \\ action</th>${A.map((a) => `<th>${ACTION_SHORT[a]}</th>`).join('')}<th>V*(s)</th></tr>`;
    $('#qmat tbody').innerHTML = S.map((s, i) => `<tr><td>${s.replace(/_/g, ' ')}</td>${A.map((a, j) => `<td class="${m.policy_idx[i] === j ? 'star' : ''}" data-q="${i}-${j}" style="background:${colorQ(m.Q[s][a], mx)}">${money(m.Q[s][a])}</td>`).join('')}<td>${money(m.V[i])}</td></tr>`).join('');
    const eu = m.expected_utility, bq = m.belief_q, ext = Math.max(...A.flatMap((a) => [Math.abs(eu[a]), Math.abs(bq[a])]), 1);
    $('#eu-bars').innerHTML = A.map((a) => {
      const row = (v, col) => { const w = Math.abs(v) / ext * 50; return `<div class="eu-track"><div class="eu-zero" style="left:50%"></div><div class="eu-bar" data-w="${w}" data-left="${v >= 0 ? 50 : 50 - w}" style="left:50%;width:0;background:${v >= 0 ? col : 'var(--crimson)'}"></div></div>`; };
      return `<div class="eu-row ${a === m.recommended_action ? 'best' : ''}"><span class="eu-name">${ACTION_SHORT[a]}</span><div style="display:grid;gap:3px">${row(eu[a], 'var(--cyan)')}${row(bq[a], 'var(--gold)')}</div><span class="v">EU ${money(eu[a])}<br><b style="color:var(--gold)">Σb·Q* ${money(bq[a])}</b></span></div>`;
    }).join('');
    requestAnimationFrame(() => $$('#eu-bars .eu-bar').forEach((b) => { b.style.left = b.dataset.left + '%'; b.style.width = b.dataset.w + '%'; }));
    tex($('#f-mdp'), String.raw`V_{k+1}(s)=\max_{a}\sum_{s'}T(s,a,s')\big[R(s,a,s')+\gamma V_k(s')\big],\quad \gamma=${m.params.gamma},\ \varepsilon<10^{-6}\ \Rightarrow\ \pi^*(s)=\arg\max_a Q^*(s,a)`);
    $('#vi-table tbody').innerHTML = m.history.map((h) => `<tr data-k="${h.k}"><td>${h.k}</td><td>${h.V[0].toFixed(6)}</td><td>${h.V[1].toFixed(6)}</td><td>${h.delta == null ? '—' : h.delta.toExponential(2)}</td></tr>`).join('');
    $('#why-mdp').textContent = m.explanation;
  }

  const SEG = 6;
  function arc(cx, cy, r, a0, a1) {
    const p = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    const [x0, y0] = p(a0), [x1, y1] = p(a1); return `M${x0},${y0} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1}`;
  }
  function renderExec(res, best) {
    const ex = res.execution, svg = $('#reactor');
    const items = [];
    if (ex.action === 'ABORT_AND_WAIT') items.push(['HOLD', 'capital held — no transaction broadcast this block']);
    else {
      if (ex.action === 'PRIVATE_RPC_PROTECT') items.push(['BUNDLE', `sign bundle → private relay · bribe ${money(ex.bribe_usd)}`]);
      items.push(['BORROW', `flash-loan ${ex.flash_loan.amount.toLocaleString('en-US', { maximumFractionDigits: 3 })} ${ex.flash_loan.asset}`]);
      ex.legs.forEach((l) => items.push(['SWAP', `${l.from}→${l.to} via ${l.pool} ${l.protocol}`]));
      items.push(['REPAY', `repay loan · keep ${money(best ? best.profit_usd : 0)}`]);
    }
    QA.txItems = items;
    const n = items.length, gap = 0.12;
    let h = `<defs><radialGradient id="rg"><stop offset="0" stop-color="#fff"/><stop offset=".25" stop-color="#FFB800"/><stop offset="1" stop-color="#FFB80000"/></radialGradient></defs>
      <circle cx="150" cy="150" r="140" fill="none" stroke="rgba(0,240,255,.2)" stroke-dasharray="3 7" class="spin1"/>
      <circle cx="150" cy="150" r="66" fill="none" stroke="rgba(157,0,255,.5)" stroke-dasharray="10 6" class="spin2"/>
      <circle cx="150" cy="150" r="52" fill="url(#rg)" opacity=".55" class="core-glow"/>`;
    for (let i = 0; i < n; i++) {
      const a0 = -Math.PI / 2 + i * 2 * Math.PI / n + gap, a1 = -Math.PI / 2 + (i + 1) * 2 * Math.PI / n - gap;
      h += `<path class="seg" data-i="${i}" d="${arc(150, 150, 100, a0, a1)}" fill="none" stroke="rgba(0,240,255,.25)" stroke-width="9" stroke-linecap="round"/>`;
      const am = (a0 + a1) / 2; h += `<text x="${150 + 122 * Math.cos(am)}" y="${150 + 122 * Math.sin(am) + 3}" fill="#7f9bb0" font-size="8" text-anchor="middle" font-family="monospace">${items[i][0]}</text>`;
    }
    h += `<text x="150" y="146" fill="#fff" font-size="12" font-weight="700" text-anchor="middle" font-family="Orbitron,sans-serif" id="reactor-main">${ACTION_SHORT[ex.action]}</text><text x="150" y="162" fill="#FFB800" font-size="9" text-anchor="middle" font-family="monospace" id="reactor-sub">${ex.atomic ? 'ATOMIC' : 'STANDBY'}</text>`;
    svg.innerHTML = h;
    $('#txplan').innerHTML = items.map((it, i) => `<li data-i="${i}"><span>${i + 1}. ${it[0]}</span><span>${esc(it[1])}</span></li>`).join('');
    const pill = $('#exec-pill'); pill.textContent = ex.status.replace(/_/g, ' '); pill.className = 'pill ' + (ex.action === 'EXECUTE_FLASH_SWAP' ? 'good' : ex.action === 'PRIVATE_RPC_PROTECT' ? 'gold' : 'bad');
    $('#exec-verdict').textContent = ex.verdict; $('#tel-ev').textContent = money(ex.expected_value_usd); $('#x-bribe').textContent = money(ex.bribe_usd);
  }
  function lightTx(i, on = true) {
    const li = $(`#txplan li[data-i="${i}"]`), sg = $(`.seg[data-i="${i}"]`);
    if (li) li.classList.toggle('lit', on);
    if (sg) { sg.setAttribute('stroke', on ? '#FFB800' : 'rgba(0,240,255,.25)'); sg.style.filter = on ? 'drop-shadow(0 0 6px #FFB800)' : ''; }
  }

  /* ---------- ambient animation: SVG sensor waveforms + mempool radiation canvas ---------------------- */
  const rad = $('#radiation'), rctx = rad.getContext('2d'); let rW = 0, rH = 0, parts = [];
  function sizeRad() { const r = rad.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2); rW = r.width; rH = r.height; rad.width = rW * d; rad.height = rH * d; rctx.setTransform(d, 0, 0, d, 0, 0); }
  addEventListener('resize', sizeRad); sizeRad();
  let tick = 0;
  function ambient(now) {
    tick++;
    const res = QA.res;
    if (res) {
      const b = res.bayes, p = b.p_trap;
      if (tick % 2 === 0) SENSOR_ORDER.forEach((k, i) => {
        const el = $('#wv-' + k); if (!el) return; const on = !!b.readings[k], amp = on ? 11 : 3, f = 0.07 + i * 0.03 + (on ? 0.06 : 0);
        let d = ''; for (let x = 0; x <= 300; x += 4) { const y = 15 + Math.sin(x * f + now / 260 * (1 + i * 0.3)) * amp * (0.7 + 0.3 * Math.sin(x * 0.02 + now / 900)) + (Math.random() - .5) * (on ? 4 : 1.5); d += (x ? 'L' : 'M') + x + ',' + y.toFixed(1); }
        el.setAttribute('d', d); el.setAttribute('stroke', on ? '#FF2A54' : '#00F0FF');
      });
      rctx.clearRect(0, 0, rW, rH); rctx.globalCompositeOperation = 'lighter';
      const cx = rW / 2, cy = rH / 2, want = 70 + p * 230;
      while (parts.length < want) parts.push({ a: Math.random() * 6.283, r: Math.random() * 20, v: .3 + Math.random() * 1.2 });
      if (parts.length > want) parts.length = Math.floor(want);
      const col = [Math.round(255 * p), Math.round(255 - 213 * p), Math.round(157 - 73 * p)];
      for (const q of parts) { q.r += q.v * (1 + p * 2); if (q.r > rW * 0.5) { q.r = Math.random() * 10; q.a = Math.random() * 6.283; } const e = 1 - q.r / (rW * 0.5); rctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${e * 0.8})`; rctx.fillRect(cx + Math.cos(q.a) * q.r * 1.6, cy + Math.sin(q.a) * q.r * 0.7, 2, 2); }
      const g = rctx.createRadialGradient(cx, cy, 0, cx, cy, 46 + p * 30); g.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},.85)`); g.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`); rctx.fillStyle = g; rctx.fillRect(cx - 80, cy - 80, 160, 160);
      SENSOR_ORDER.forEach((k, i) => {
        const ang = -Math.PI / 2 + i * 2.094, sx = cx + Math.cos(ang) * rW * 0.38, sy = cy + Math.sin(ang) * rH * 0.38, on = b.readings[k];
        rctx.strokeStyle = on ? 'rgba(255,42,84,.7)' : 'rgba(0,240,255,.18)'; rctx.lineWidth = on ? 2 : 1; rctx.beginPath(); rctx.moveTo(sx, sy); rctx.lineTo(cx, cy); rctx.stroke();
        rctx.fillStyle = on ? '#FF2A54' : '#00F0FF'; rctx.beginPath(); rctx.arc(sx, sy, on ? 6 : 4, 0, 6.283); rctx.fill();
        rctx.globalCompositeOperation = 'source-over'; rctx.fillStyle = '#9fd'; rctx.font = '9px monospace'; rctx.textAlign = 'center'; rctx.fillText(b.sensors[k].label, sx, sy + 17); rctx.globalCompositeOperation = 'lighter';
      });
      rctx.globalCompositeOperation = 'source-over';
    }
    requestAnimationFrame(ambient);
  }
  requestAnimationFrame(ambient);
  setInterval(() => {
    const s = galaxy.state; $('#z-read').textContent = Math.round(s.z); $('#fps-read').textContent = Math.round(galaxy.fps);
    $('#rail-fill').style.height = (s.progress * 100) + '%'; $$('.tick').forEach((t, i) => t.classList.toggle('active', s.layer === i + 1));
    document.body.dataset.layer = s.layer;
    if (galaxy.quality < 0.8 && galaxy.fps < 30) document.body.classList.add('lowfx');
  }, 120);

  /* ---------- drawers & buttons ----------------------------------------------------------------------- */
  const drawer = $('#rubric'), logdock = $('#logdock');
  const toggle = (el, btn, on) => { const o = on ?? !el.classList.contains('open'); el.classList.toggle('open', o); el.setAttribute('aria-hidden', String(!o)); btn && btn.classList.toggle('on', o); };
  $('#btn-rubric').addEventListener('click', () => toggle(drawer, $('#btn-rubric')));
  $('#rubric-close').addEventListener('click', () => toggle(drawer, $('#btn-rubric'), false));
  $('#btn-log').addEventListener('click', () => toggle(logdock, $('#btn-log')));
  $('#log-clear').addEventListener('click', () => (logEl.textContent = ''));
  $('#btn-mute').addEventListener('click', (e) => { QA.muted = !QA.muted; e.currentTarget.textContent = QA.muted ? '🔇' : '🔊'; });
  $$('[data-inspect]').forEach((b) => b.addEventListener('click', () => $('#inspect-' + b.dataset.inspect).classList.toggle('open')));
  addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggle(drawer, $('#btn-rubric'), false); toggle(logdock, $('#btn-log'), false); } });

  /* ---------- A* replay -------------------------------------------------------------------------------- */
  cons.onStep = (s) => {
    $$('#trace-table tr.hl').forEach((r) => r.classList.remove('hl'));
    const tr = $(`#trace-table tbody tr[data-step="${s.step}"]`);
    if (tr) { tr.classList.add('hl'); const w = tr.closest('.table-wrap'); w.scrollTop = Math.max(0, tr.offsetTop - w.clientHeight / 2); }
    sfx(320 + Math.min(s.step, 20) * 28, 0.06, 'sine', 0.025);
    if (s.event === 'EXPAND') log(`  A* pop #${s.step} ${s.path}  g=${sgn(s.g)} h=${sgn(s.h)} f=${sgn(s.f)}  |open|=${s.open_size}  children=${s.children.length}`);
    else if (s.event === 'GOAL') { log(`  A* GOAL ${s.path}  g=${sgn(s.g)}  ⇒ optimal (admissible h)`, 'ok'); sfx(880, 0.3, 'triangle', 0.05, 1.5); }
    else log('  A* root pruned: f>0 ⇒ even the idealised cycle loses money', 'bad');
  };
  $('#btn-replay').addEventListener('click', async () => { if (!QA.res) return; galaxy.pulse('#00F0FF', .6); await cons.playAStar(QA.res, 1.4); $$('#trace-table tr.hl').forEach((r) => r.classList.remove('hl')); });

  /* ---------- QUANTUM TRACE ------------------------------------------------------------------------------ */
  const stageEl = (n) => $(`.stage[data-stage="${n}"]`);
  function setStage(n) { $$('.stage').forEach((s) => { const i = +s.dataset.stage; s.classList.toggle('active', i === n); s.classList.toggle('done', i < n); }); }
  async function trace() {
    if (QA.trace.state === 'running') return;
    QA.trace = { state: 'running', stage: 0 }; document.body.dataset.trace = 'running'; document.body.dataset.stage = '0';
    $('#btn-trace').disabled = true; toggle(logdock, $('#btn-log'), true);
    const res = QA.res || (await run(QA.scenario)); const k = QA.speed;
    log(`\n═══ QUANTUM TRACE · ${res.scenario.name} ═══`, 'st');
    // stage 1
    setStage(1); QA.trace.stage = 1; document.body.dataset.stage = '1'; await gotoLayer(1, 1100 / k); galaxy.pulse('#00F0FF'); sfx(220, .5, 'sawtooth', .03, 2);
    log('▶ STAGE 1 · A* WORMHOLE SCAN  (frontier pulses = open-set expansions)', 'st');
    await cons.playAStar(res, 1.5 * k); $$('#trace-table tr.hl').forEach((r) => r.classList.remove('hl'));
    const best = res.astar.best || res.astar.fallback_best;
    log(best ? `  ⇒ ${best.route.join(' → ')}  net ${money(best.profit_usd)} (${best.profit_bps.toFixed(1)} bps)  gas ${money(best.gas_total_usd)} · A* ${res.astar.expanded} vs BFS ${res.bfs.expanded} expansions` : '  ⇒ no cycle', 'ok');
    await sleep(500 / k);
    // stage 2
    setStage(2); QA.trace.stage = 2; document.body.dataset.stage = '2'; await gotoLayer(2, 1300 / k); galaxy.pulse('#9D00FF'); sfx(180, .5, 'sawtooth', .03, 2.4);
    log('▶ STAGE 2 · BAYESIAN SPECTRAL TELEMETRY', 'st');
    const b = res.bayes; log(`  prior P(H1)=${b.prior_h1.toFixed(4)}`);
    $$('#seq-table tbody tr').forEach((r) => (r.style.opacity = 0.25)); setGauge(b.prior_h1); drawChain(b, 0); await sleep(500 / k);
    for (let i = 0; i < b.sequential.length; i++) {
      const s = b.sequential[i]; const row = $$('#seq-table tbody tr')[i]; if (row) { row.style.opacity = 1; row.classList.add('hl'); }
      setGauge(s.posterior); drawChain(b, i + 1); sfx(s.reading === 'FIRED' ? 300 : 620, .18, 'square', .03);
      if (s.reading === 'FIRED') galaxy.pulse('#FF2A54', .5);
      log(`  ${s.sensor} ${s.reading}: LR=${s.likelihood_ratio.toFixed(3)}  P(H1) ${s.prior.toFixed(4)} → ${s.posterior.toFixed(4)}`, s.reading === 'FIRED' ? 'bad' : '');
      await sleep(850 / k); if (row) row.classList.remove('hl');
    }
    $$('#seq-table tbody tr').forEach((r) => (r.style.opacity = 1)); setGauge(b.p_trap);
    log(`  P(E|H1)=${f6(b.likelihood_h1)}  P(E|H0)=${f6(b.likelihood_h0)}  P(E)=${f6(b.marginal)}  ⇒ P(H1|E)=${b.p_trap.toFixed(6)} (${b.verdict})`, b.verdict === 'HOSTILE' ? 'bad' : 'ok');
    await sleep(600 / k);
    // stage 3
    setStage(3); QA.trace.stage = 3; document.body.dataset.stage = '3'; await gotoLayer(3, 1300 / k); galaxy.pulse('#FFB800'); sfx(150, .5, 'sawtooth', .03, 3);
    const m = res.mdp; log('▶ STAGE 3 · MDP BELLMAN COLLAPSE', 'st');
    log(`  belief b=[${m.belief.map((x) => x.toFixed(4)).join(', ')}]  p_trap → state distribution`, 'vi');
    for (const a of m.actions) { log(`  EU(${ACTION_SHORT[a]}) = ${money(m.expected_utility[a])}`, 'vi'); sfx(260 + m.actions.indexOf(a) * 90, .08, 'sine'); await sleep(280 / k); }
    const rows = $$('#vi-table tbody tr');
    for (let i = 0; i < rows.length; i++) { rows[i].classList.add('hl'); const h = m.history[i]; log(`  VI k=${h.k}  V(s0)=${h.V[0].toFixed(6)} V(s1)=${h.V[1].toFixed(6)} Δ=${h.delta == null ? '—' : h.delta.toExponential(2)}`, 'vi'); sfx(400 + i * 40, .06, 'triangle'); await sleep(300 / k); rows[i].classList.remove('hl'); }
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) { const c = $(`[data-q="${i}-${j}"]`); c.classList.add('flash'); sfx(500 + j * 90, .05, 'sine', .02); await sleep(170 / k); c.classList.remove('flash'); }
    log(`  π*(s0)=${m.policy[m.states[0]]}  π*(s1)=${m.policy[m.states[1]]}  ⇒ ${m.recommended_action}`, 'ok'); await sleep(500 / k);
    // stage 4
    setStage(4); QA.trace.stage = 4; document.body.dataset.stage = '4'; galaxy.pulse('#00FF9D'); sfx(120, .6, 'sawtooth', .04, 4);
    const ex = res.execution; log(`▶ STAGE 4 · ATOMIC BLOCK EXECUTION · ${ex.status}`, 'st');
    $('#panel-reactor').scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(600 / k);
    (QA.txItems || []).forEach((_, i) => lightTx(i, false));
    for (let i = 0; i < (QA.txItems || []).length; i++) { lightTx(i); log(`  [${i + 1}] ${QA.txItems[i][0]} ${QA.txItems[i][1]}`, 'ok'); sfx(440 + i * 110, .12, 'square', .03); galaxy.pulse('#FFB800', .35); await sleep(560 / k); }
    $('#reactor-sub').textContent = ex.atomic ? 'SETTLED' : 'HELD'; sfx(990, .4, 'triangle', .06, 1.4); galaxy.pulse('#00FF9D', 1);
    log(`  ✔ ${ex.verdict}  (EV ${money(ex.expected_value_usd)})`, 'ok');
    setStage(5); QA.trace = { state: 'done', stage: 4 }; document.body.dataset.trace = 'done'; document.body.dataset.stage = '4';
    $('#btn-trace').disabled = false;
  }
  $('#btn-trace').addEventListener('click', trace);
  QA.runTrace = trace;

  /* ---------- boot ---------------------------------------------------------------------------------------------- */
  deckLabels();
  run('alpha', { quiet: true }).then(() => log('QUASAR-ARB online · scenario Alpha loaded · ' + galaxy.particleCount.toLocaleString() + ' particles', 'ok')).catch((e) => console.error(e));
})();

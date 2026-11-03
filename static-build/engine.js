/* QUASAR-ARB · static-build/engine.js
 * Faithful client-side port of core/{graph_search,bayesian_mempool,mdp_controller,pipeline}.py.
 * Reference data (tokens, pools, scenarios, sensors) comes from data.js, generated from the Python modules
 * by build_static.py, so Python stays the single source of truth.  Parity is checked by tests/test_static_parity.py.
 */
(function (root) {
  'use strict';
  const D = root.QUASAR_DATA;
  const TOKENS = D.TOKENS, TOKEN_LIST = Object.keys(TOKENS);
  const STATES = ['s0_Safe_Optimal_Window', 's1_Volatile_Sandwich_Threat', 's2_Terminal_Executed', 's3_Terminal_Aborted'];
  const ACTIONS = ['EXECUTE_FLASH_SWAP', 'PRIVATE_RPC_PROTECT', 'ABORT_AND_WAIT'];
  const fmt = (x, d = 2) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (x) => '$' + fmt(x);
  const pc1 = (x) => (x * 100).toFixed(1) + '%';
  const sum = (a) => a.reduce((s, v) => s + v, 0);
  const argmax = (a) => a.reduce((bi, v, i) => (v > a[bi] ? i : bi), 0);

  /* ================= Algorithm 1 ================= */
  class Market {
    constructor(profile, gasGwei = 20, dislocation = 1) {
      this.prices = {}; for (const t of TOKEN_LIST) this.prices[t] = TOKENS[t].price;
      this.gasGwei = +gasGwei; this.pools = []; profile = profile || {};
      for (const [id, a, b, protocol, fee, tvl] of D.POOL_DEFS) {
        const dev = (profile[id] || 0) * dislocation;
        const ra = tvl / 2 / this.prices[a], rb = tvl / 2 / this.prices[b] * (1 + dev / 1e4);
        this.pools.push({ id, a, b, protocol, fee, tvl_usd: tvl, dev_bps: dev, reserve_a: ra, reserve_b: rb,
          gas_units: D.PROTOCOL_GAS_UNITS[protocol], kappa: 1 - fee, color: D.PROTOCOL_COLORS[protocol] });
      }
      this.edges = []; this.adj = {}; for (const t of TOKEN_LIST) this.adj[t] = [];
      for (const p of this.pools) for (const [s, d] of [[p.a, p.b], [p.b, p.a]]) { const e = { pool: p, src: s, dst: d }; this.edges.push(e); this.adj[s].push(e); }
    }
    gasUsd(p) { return p.gas_units * this.gasGwei * 1e-9 * this.prices.ETH; }
    static ammOut(x, y, k, dx) { return dx <= 0 ? 0 : y * k * dx / (x + k * dx); }
    reserves(p, tin) { return tin === p.a ? [p.reserve_a, p.reserve_b] : [p.reserve_b, p.reserve_a]; }
    spotRatio(e) { const [x, y] = this.reserves(e.pool, e.src); return e.pool.kappa * (y / x) * this.prices[e.dst] / this.prices[e.src]; }
    hop(e, amountIn) {
      const [x, y] = this.reserves(e.pool, e.src);
      const gross = Market.ammOut(x, y, e.pool.kappa, amountIn), gas = this.gasUsd(e.pool);
      const net = gross - gas / this.prices[e.dst], spotOut = e.pool.kappa * (y / x) * amountIn;
      const impact = spotOut > 0 ? 1 - gross / spotOut : 0;
      const vin = amountIn * this.prices[e.src], vout = net * this.prices[e.dst];
      const r = vin > 0 && vout > 0 ? vout / vin : 0;
      return { from: e.src, to: e.dst, pool: e.pool.id, protocol: e.pool.protocol, fee_pct: Math.round(e.pool.fee * 1e5) / 1e3,
        amount_in: amountIn, amount_out_gross: gross, gas_usd: gas, amount_out_net: net, price_impact_pct: impact * 100,
        r_eff: r, weight: r > 0 ? -Math.log(r) : Infinity };
    }
    evaluateCycle(start, edges, cap) {
      let amount = cap / this.prices[start]; const a0 = amount, legs = [];
      for (const e of edges) { const h = this.hop(e, amount); legs.push(h); amount = h.amount_out_net; if (amount <= 0) break; }
      const profit = amount > 0 ? (amount - a0) * this.prices[start] : -cap;
      return { legs, final_amount: amount, start_amount: a0, profit_usd: profit, gas_total_usd: sum(legs.map((l) => l.gas_usd)), profit_bps: profit / cap * 1e4 };
    }
  }

  function buildHeuristic(m, start, maxHops) {
    const best = { 0: {} }; for (const t of TOKEN_LIST) best[0][t] = 0;
    for (let k = 1; k <= maxHops; k++) {
      best[k] = {};
      for (const t of TOKEN_LIST) {
        let mx = 0;
        for (const e of m.adj[t]) { const cont = Math.max(e.dst === start ? 1 : 0, best[k - 1][e.dst]); mx = Math.max(mx, m.spotRatio(e) * cont); }
        best[k][t] = mx;
      }
    }
    return best;
  }
  const hCost = (best, t, left) => { const v = left >= 1 ? best[left][t] : 0; return v > 0 ? -Math.log(v) : Infinity; };

  class Heap {   // min-heap on [f, hops, counter]
    constructor() { this.a = []; }
    static lt(x, y) { return x.f !== y.f ? x.f < y.f : x.hops !== y.hops ? x.hops < y.hops : x.c < y.c; }
    get length() { return this.a.length; }
    push(it) { const a = this.a; a.push(it); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (Heap.lt(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; } }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, s = i; if (l < a.length && Heap.lt(a[l], a[s])) s = l; if (r < a.length && Heap.lt(a[r], a[s])) s = r; if (s === i) break; [a[i], a[s]] = [a[s], a[i]]; i = s; } } return top; }
    sorted(k) { return this.a.slice().sort((x, y) => (Heap.lt(x, y) ? -1 : Heap.lt(y, x) ? 1 : 0)).slice(0, k); }
  }
  const nodeF = (n) => n.g + n.h, nodeLabel = (n) => n.tokens.join('→');

  function* children(m, node, start, maxHops, minHops) {
    const used = new Set(node.edges.map((e) => e.pool.id)), tok = node.tokens[node.tokens.length - 1], hops = node.edges.length;
    for (const e of m.adj[tok]) {
      if (used.has(e.pool.id)) continue;
      const closing = e.dst === start;
      if (closing && hops + 1 < minHops) continue;
      if (!closing && (node.tokens.includes(e.dst) || hops + 1 >= maxHops)) continue;
      const h = m.hop(e, node.amount); if (h.amount_out_net <= 0) continue;
      yield [e, h];
    }
  }
  function makeChild(m, node, e, h, cap) {
    const g = -Math.log(h.amount_out_net * m.prices[e.dst] / cap);
    return { tokens: node.tokens.concat(e.dst), edges: node.edges.concat(e), amount: h.amount_out_net, g, h: 0, legs: node.legs.concat(h) };
  }
  function resultFromNode(m, start, n, cap) {
    const ev = m.evaluateCycle(start, n.edges, cap);
    ev.route = n.tokens.slice(); ev.pools = n.edges.map((e) => e.pool.id); ev.hops = n.edges.length; ev.total_weight = sum(ev.legs.map((l) => l.weight));
    return ev;
  }

  function astarSearch(m, start = 'USDC', cap = 50000, maxHops = 4, minHops = 2, prune = true, openK = 6, traceLimit = 400) {
    const best = buildHeuristic(m, start, maxHops);
    const root = { tokens: [start], edges: [], amount: cap / m.prices[start], g: 0, h: 0, legs: [] };
    root.h = hCost(best, start, maxHops);
    let counter = 0; const heap = new Heap(); heap.push({ f: nodeF(root), hops: 0, c: counter++, n: root });
    const trace = []; let expanded = 0, generated = 0, pruned = 0, goal = null;
    if (prune && nodeF(root) > 0) { pruned++; heap.a.length = 0; trace.push({ step: 0, event: 'ROOT_PRUNED', path: start, g: 0, h: root.h, f: nodeF(root), open_set: [], children: [] }); }
    while (heap.length) {
      const { n: node } = heap.pop();
      if (node.tokens[node.tokens.length - 1] === start && node.edges.length >= minHops) {
        goal = node;
        if (trace.length < traceLimit) trace.push({ step: expanded + 1, event: 'GOAL', path: nodeLabel(node), tokens: node.tokens.slice(), g: node.g, h: 0, f: nodeF(node), hops: node.edges.length, open_set: [], children: [] });
        break;
      }
      expanded++; const kids = [];
      for (const [e, h] of children(m, node, start, maxHops, minHops)) {
        const ch = makeChild(m, node, e, h, cap), left = maxHops - ch.edges.length;
        ch.h = ch.tokens[ch.tokens.length - 1] === start ? 0 : hCost(best, ch.tokens[ch.tokens.length - 1], left);
        generated++;
        const f = nodeF(ch), keep = !(prune && f > 1e-12) && isFinite(f);
        kids.push({ path: nodeLabel(ch), pool: e.pool.id, g: ch.g, h: ch.h, f, kept: keep });
        if (keep) heap.push({ f, hops: ch.edges.length, c: counter++, n: ch }); else pruned++;
      }
      if (trace.length < traceLimit) trace.push({ step: expanded, event: 'EXPAND', path: nodeLabel(node), tokens: node.tokens.slice(), g: node.g, h: node.h, f: nodeF(node),
        hops: node.edges.length, last_pool: node.edges.length ? node.edges[node.edges.length - 1].pool.id : null, open_size: heap.length,
        open_set: heap.sorted(openK).map((x) => ({ path: nodeLabel(x.n), g: x.n.g, h: x.n.h, f: nodeF(x.n) })), children: kids });
    }
    const res = { algorithm: 'A*', start, capital_usd: cap, max_hops: maxHops, expanded, generated, pruned, found: goal !== null, trace,
      trace_truncated: expanded > traceLimit, heuristic: { definition: 'h(n,k) = -ln(best idealised spot return to start within k hops)', root_h: root.h } };
    if (goal) { res.best = resultFromNode(m, start, goal, cap); res.best.f = nodeF(goal); }
    return res;
  }

  function bfsSearch(m, start = 'USDC', cap = 50000, maxHops = 4, minHops = 2) {
    const q = [{ tokens: [start], edges: [], amount: cap / m.prices[start], g: 0, h: 0, legs: [] }];
    let head = 0, expanded = 0, generated = 0, bestNode = null, firstProf = null, cycles = 0;
    while (head < q.length) {
      const node = q[head++];
      if (node.tokens[node.tokens.length - 1] === start && node.edges.length >= minHops) {
        cycles++; if (!bestNode || node.g < bestNode.g) bestNode = node;
        if (node.g < 0 && firstProf === null) firstProf = expanded; continue;
      }
      expanded++;
      for (const [e, h] of children(m, node, start, maxHops, minHops)) { q.push(makeChild(m, node, e, h, cap)); generated++; }
    }
    const res = { algorithm: 'BFS', start, expanded, generated, cycles_found: cycles, first_profitable_at_expansion: firstProf, found: bestNode !== null };
    if (bestNode) res.best = resultFromNode(m, start, bestNode, cap);
    return res;
  }

  function compareExplanation(a, b) {
    if (!a.found) return `A* proved in ${a.expanded} expansions that even the idealised best cycle (zero impact, zero gas) cannot beat break-even, while uninformed BFS had to enumerate ${b.expanded} partial routes to learn the same.`;
    const ea = a.expanded, eb = b.expanded, same = Math.abs(a.best.profit_usd - b.best.profit_usd) < 1e-6, ratio = eb / Math.max(ea, 1);
    if (ea < eb) return `A* expanded ${ea} nodes versus ${eb} for BFS (${ratio.toFixed(1)}× fewer) because h(n) — the best idealised return to the start token — let it discard every branch whose optimistic f(n)=g(n)+h(n) was already unprofitable, and it ${same ? 'matched' : 'did NOT match'} BFS's optimal cycle.`;
    return `On this tiny graph A* expanded ${ea} nodes versus ${eb} for BFS: the admissible bound pruned little, but the optimal cycle is identical (${same ? 'yes' : 'NO'}), which is exactly the guarantee admissibility gives.`;
  }

  /* ================= Algorithm 2 ================= */
  const lik = (s, r, h1) => { const p = h1 ? s.p_on_h1 : s.p_on_h0; return r ? p : 1 - p; };
  function infer(prior, readings) {
    const S = D.SENSORS;
    if (!(prior >= 0 && prior <= 1)) throw new Error('prior must lie in [0,1]');
    const observed = Object.entries(readings).filter(([n, r]) => r !== null && r !== undefined && n in S).map(([n, r]) => [n, !!r]);
    let p = prior; const seq = [];
    for (const [name, r] of observed) {
      const s = S[name], l1 = lik(s, r, true), l0 = lik(s, r, false), marg = l1 * p + l0 * (1 - p);
      if (marg <= 0) throw new Error('zero-probability evidence');
      const post = l1 * p / marg;
      seq.push({ sensor: s.label, key: name, reading: r ? 'FIRED' : 'SILENT', detail: r ? s.detail_on : s.detail_off, prior: p, p_e_given_h1: l1, p_e_given_h0: l0, p_e: marg, posterior: post, likelihood_ratio: l0 > 0 ? l1 / l0 : Infinity });
      p = post;
    }
    let L1 = 1, L0 = 1; for (const [n, r] of observed) { L1 *= lik(S[n], r, true); L0 *= lik(S[n], r, false); }
    const pe = L1 * prior + L0 * (1 - prior); if (pe <= 0) throw new Error('zero-probability evidence');
    const post = L1 * prior / pe, verdict = post >= 0.5 ? 'HOSTILE' : 'CLEAN';
    const pretty = observed.map(([n, r]) => `${S[n].label}=${r ? 'ON' : 'off'}`).join(', ') || 'no sensors observed';
    let expl = `Starting from a ${pc1(prior)} prior of a sandwich trap, the evidence (${pretty}) is ${(L1 / L0).toFixed(2)}× more likely under H1 than H0, so Bayes' rule moves the trap probability to ${pc1(post)} (${verdict}).`;
    if (L0 === 0) expl = 'Evidence is impossible under H0, so the trap is certain.';
    const j = (f) => observed.map(([n, r]) => lik(S[n], r, f).toFixed(4)).join(' × ') || '1';
    const steps = [`P(H1) = ${prior.toFixed(6)},  P(H0) = ${(1 - prior).toFixed(6)}`, `P(E|H1) = ${j(true)} = ${L1.toFixed(6)}`, `P(E|H0) = ${j(false)} = ${L0.toFixed(6)}`,
      `P(E) = P(E|H1)P(H1) + P(E|H0)P(H0) = ${L1.toFixed(6)}·${prior.toFixed(4)} + ${L0.toFixed(6)}·${(1 - prior).toFixed(4)} = ${pe.toFixed(6)}`,
      `P(H1|E) = P(E|H1)P(H1) / P(E) = ${(L1 * prior).toFixed(6)} / ${pe.toFixed(6)} = ${post.toFixed(6)}`];
    const sensors = {}, rd = {}; for (const [n, s] of Object.entries(S)) { sensors[n] = { label: s.label, p_on_h1: s.p_on_h1, p_on_h0: s.p_on_h0, detail_on: s.detail_on, detail_off: s.detail_off }; rd[n] = n in readings ? readings[n] : null; }
    return { algorithm: 'Bayes', prior_h1: prior, prior_h0: 1 - prior, readings: rd, sensors, sequential: seq, likelihood_h1: L1, likelihood_h0: L0, marginal: pe,
      posterior_h1: post, posterior_h0: 1 - post, p_trap: post, verdict, steps, explanation: expl, sequential_matches_batch: Math.abs(p - post) < 1e-12 };
  }

  /* ================= Algorithm 3 ================= */
  function mulberry(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const MDP_DEFAULTS = { gamma: 0.95, epsilon: 1e-6, loss_frac: 0.012, p_sandwich_public: 0.90, p_sandwich_private: 0.05, p_inclusion_private: 0.92, bribe_frac: 0.25, bribe_min: 5, p_gone: 0.35, persist: 0.60, onset: 0.10, wait_cost_frac: 0.01, wait_cost_min: 1 };
  function buildModel(m) {
    if (!(m.p_trap >= 0 && m.p_trap <= 1)) throw new Error('p_trap must lie in [0,1]');
    if (!(m.gamma >= 0 && m.gamma < 1)) throw new Error('discount factor must lie in [0,1)');
    const loss = m.loss_frac * m.capital + m.gas_total, bribe = Math.max(m.bribe_min, m.bribe_frac * Math.max(m.net_profit, 0)), wait = Math.max(m.wait_cost_min, m.wait_cost_frac * Math.max(m.net_profit, 0));
    const T = {}, set = (s, a, rows) => { T[s + ',' + a] = rows; };   // rows: [[s', prob, reward], ...]
    set(0, 0, [[2, 1, m.net_profit]]);
    set(1, 0, [[2, 1, m.p_sandwich_public * -loss + (1 - m.p_sandwich_public) * m.net_profit]]);
    const i = m.p_inclusion_private;
    set(0, 1, [[2, i, m.net_profit - bribe], [3, 1 - i, 0]]);
    const r1 = m.p_sandwich_private * (-loss - bribe) + (1 - m.p_sandwich_private) * (m.net_profit - bribe);
    set(1, 1, [[2, i, r1], [3, 1 - i, 0]]);
    const g = m.p_gone;
    set(0, 2, [[0, (1 - g) * (1 - m.onset), -wait], [1, (1 - g) * m.onset, -wait], [3, g, -wait]]);
    set(1, 2, [[0, (1 - g) * (1 - m.persist), -wait], [1, (1 - g) * m.persist, -wait], [3, g, -wait]]);
    for (const t of [2, 3]) for (let a = 0; a < 3; a++) set(t, a, [[t, 1, 0]]);
    for (const [k, row] of Object.entries(T)) if (Math.abs(sum(row.map((r) => r[1])) - 1) > 1e-9) throw new Error('non-stochastic row ' + k);
    return [T, { loss_if_sandwiched: loss, bribe, wait_cost: wait }];
  }
  const qval = (T, V, gamma, s, a) => sum(T[s + ',' + a].map(([s2, p, r]) => p * (r + gamma * V[s2])));
  function valueIteration(T, gamma, eps) {
    let V = [0, 0, 0, 0]; const hist = [{ k: 0, V: V.slice(0, 2), delta: null }]; let k = 0;
    while (k < 100000) {
      k++; const Vn = V.slice();
      for (const s of [0, 1]) Vn[s] = Math.max(qval(T, V, gamma, s, 0), qval(T, V, gamma, s, 1), qval(T, V, gamma, s, 2));
      const delta = Math.max(Math.abs(Vn[0] - V[0]), Math.abs(Vn[1] - V[1])); V = Vn; hist.push({ k, V: V.slice(0, 2), delta }); if (delta < eps) break;
    }
    const Q = [0, 1].map((s) => [0, 1, 2].map((a) => qval(T, V, gamma, s, a)));
    return [V, Q, hist, k];
  }
  function monteCarlo(T, belief, n = 4000, seed = 7) {
    const rng = mulberry(seed);
    return [0, 1, 2].map((a) => { let tot = 0; for (let i = 0; i < n; i++) { const s = rng() < belief[1] ? 1 : 0, u = rng(); let acc = 0; for (const [, p, r] of T[s + ',' + a]) { acc += p; if (u <= acc) { tot += r; break; } } } return tot / n; });
  }
  function solveMdp(m) {
    m = Object.assign({}, MDP_DEFAULTS, m);
    const [T, derived] = buildModel(m), belief = [1 - m.p_trap, m.p_trap];
    const eu = [0, 1, 2].map((a) => sum([0, 1].map((s) => belief[s] * sum(T[s + ',' + a].map(([, p, r]) => p * r)))));
    const [V, Q, hist, iters] = valueIteration(T, m.gamma, m.epsilon);
    const policy = [0, 1].map((s) => argmax(Q[s])), beliefQ = [0, 1, 2].map((a) => belief[0] * Q[0][a] + belief[1] * Q[1][a]);
    const rec = argmax(beliefQ), oneStep = argmax(eu), mc = monteCarlo(T, belief);
    const trans = []; for (const s of [0, 1]) for (let a = 0; a < 3; a++) for (const [s2, p, r] of T[s + ',' + a]) trans.push({ s: STATES[s], a: ACTIONS[a], s_next: STATES[s2], T: p, R: r });
    const prof = m.net_profit, polTxt = {}; [0, 1].forEach((s) => (polTxt[STATES[s]] = ACTIONS[policy[s]]));
    const expl = `With a ${pc1(m.p_trap)} trap belief and an A* net profit of ${usd(prof)}, ${ACTIONS[rec]} has the highest long-run expected value (${usd(beliefQ[rec])}); ` +
      (rec === 0 ? 'EXECUTE wins because the hostile mass is too small to justify a bribe or a delay.' : '') +
      (rec === 1 ? 'the private relay pays a bribe but removes most of the sandwich loss, beating a naked broadcast.' : '') +
      (rec === 2 ? 'holding capital beats both broadcasting options because their expected loss/bribe exceeds the profit at stake.' : '');
    const steps = [`Belief b = [P(s0), P(s1)] = [${belief[0].toFixed(4)}, ${belief[1].toFixed(4)}]  (p_trap from Bayes)`,
      `Rewards: profit P=${usd(prof)}, sandwich loss L=${usd(derived.loss_if_sandwiched)}, bribe B=${usd(derived.bribe)}, wait cost c=${usd(derived.wait_cost)}`,
      "One-step EU(a) = Σ_s b(s) Σ_s' T(s,a,s')R(s,a,s') → " + ACTIONS.map((a, i) => `${a}=${usd(eu[i])}`).join(', '),
      `Value iteration V_{k+1}(s)=max_a Σ T[R+γV_k(s')], γ=${m.gamma}, converged after ${iters} sweeps (Δ<${m.epsilon})`,
      'Q* rows s0,s1: ' + [0, 1].map((s) => `${STATES[s].slice(0, 2)}=[` + Q[s].map((q) => fmt(q)).join(', ') + ']').join('; '),
      `π*(s0)=${ACTIONS[policy[0]]}, π*(s1)=${ACTIONS[policy[1]]};  argmax_a Σ b(s)Q*(s,a) = ${ACTIONS[rec]}`];
    const zip = (arr) => { const o = {}; ACTIONS.forEach((a, i) => (o[a] = arr[i])); return o; };
    const Qd = {}; [0, 1].forEach((s) => (Qd[STATES[s]] = zip(Q[s])));
    return { algorithm: 'MDP', params: m, derived, states: STATES, actions: ACTIONS, belief, transitions: trans, expected_utility: zip(eu), monte_carlo: zip(mc), V: V.slice(0, 2), Q: Qd, Q_matrix: Q,
      policy: polTxt, policy_idx: policy, belief_q: zip(beliefQ), recommended_action: ACTIONS[rec], recommended_idx: rec, one_step_best: ACTIONS[oneStep], iterations: iters, history: hist,
      converged: hist[hist.length - 1].delta !== null && hist[hist.length - 1].delta < m.epsilon, steps, explanation: expl };
  }

  /* ================= Pipeline ================= */
  const SENSOR_KEYS = Object.keys(D.SENSORS);
  function resolveParams(req) {
    req = req || {}; const id = req.scenario in D.SCENARIOS ? req.scenario : 'alpha';
    const base = JSON.parse(JSON.stringify(D.SCENARIOS[id]));
    for (const k of ['capital', 'gas_gwei', 'prior', 'gamma', 'dislocation']) if (req[k] !== undefined && req[k] !== null) base[k] = +req[k];
    if (req.sensors && typeof req.sensors === 'object') for (const k of SENSOR_KEYS) if (k in req.sensors) base.sensors[k] = !!req.sensors[k];
    if (req.market) { if (!(req.market in D.PROFILES)) throw new Error('unknown market ' + req.market); base.market = req.market; }
    if (req.start in TOKENS) base.start = req.start; if (!base.start) base.start = 'USDC';
    const cl = (x, a, b) => Math.min(Math.max(x, a), b);
    base.capital = cl(base.capital, 1000, 250000); base.gas_gwei = cl(base.gas_gwei, 1, 1000); base.prior = cl(base.prior, 0, 1); base.gamma = cl(base.gamma, 0, 0.999); base.dislocation = cl(base.dislocation, 0, 5);
    base.scenario = base.id; return base;
  }
  function poolMetrics(m, cap, routePools, pTrap, sensors) {
    let hot = 0; if (sensors.mev_bot_signature) hot += 0.25; if (sensors.gas_priority_spike) hot += 0.15;
    return m.pools.map((p) => {
      const dx = cap / m.prices[p.a], out = Market.ammOut(p.reserve_a, p.reserve_b, p.kappa, dx), impact = 1 - out / (p.kappa * (p.reserve_b / p.reserve_a) * dx);
      const thin = Math.min(1, cap / p.tvl_usd * 12);
      let mev = D.PROTOCOL_MEV_BASE[p.protocol] * (0.55 + 0.45 * thin) + hot * (p.protocol !== 'Curve' ? 0.6 : 0.3);
      if (routePools.has(p.id)) mev += 0.9 * pTrap * (1 - mev);
      return { id: p.id, slippage_pct: impact * 100, mev_exposure: Math.min(1, mev), gas_usd: m.gasUsd(p), depth_usd: p.tvl_usd };
    });
  }
  function runPipeline(req) {
    const t0 = performance.now(), P = resolveParams(req), market = new Market(D.PROFILES[P.market], P.gas_gwei, P.dislocation), start = P.start, cap = P.capital;
    const astar = astarSearch(market, start, cap, 4, 2, true); let fallback = false;
    if (!astar.found) { const full = astarSearch(market, start, cap, 4, 2, false); astar.fallback_best = full.best; astar.fallback_expanded = full.expanded; fallback = true; }
    const bfs = bfsSearch(market, start, cap, 4), best = astar.best || astar.fallback_best;
    const profitable = !!(astar.found && best && best.profit_usd > 0), netProfit = profitable ? best.profit_usd : 0, gasTotal = best ? best.gas_total_usd : 0;
    astar.profitable = profitable; astar.explanation = compareExplanation(astar, bfs);
    astar.rubric = { input: { tokens: TOKEN_LIST.length, directed_edges: market.edges.length, start, capital_usd: cap, gas_gwei: P.gas_gwei, max_hops: 4 },
      steps: [`w(u→v) = -ln r_eff(u→v) with constant-product impact and gas drag on ${market.edges.length} directed edges`, `h(n,k) = -ln(best idealised spot return to ${start} within k hops); root h = ${astar.heuristic.root_h.toFixed(5)}`,
        `Priority-queue expansions: ${astar.expanded} (generated ${astar.generated}, pruned ${astar.pruned})`, best ? `Goal popped: ${best.route.join(' → ')} with g = ${best.total_weight.toFixed(6)}` : 'No cycle'],
      output: best ? { route: best.route, pools: best.pools, net_profit_usd: best.profit_usd, profit_bps: best.profit_bps, gas_usd: best.gas_total_usd } : null, explanation: astar.explanation };
    bfs.explanation = 'BFS expands every partial route level by level without any estimate of what lies ahead.';
    const bayes = infer(P.prior, P.sensors);
    bayes.rubric = { input: { prior_h1: P.prior, sensors: P.sensors }, steps: bayes.steps, output: { posterior_h1: bayes.posterior_h1 }, explanation: bayes.explanation };
    const mdp = solveMdp({ net_profit: netProfit, gas_total: gasTotal, capital: cap, p_trap: bayes.p_trap, gamma: P.gamma, onset: Math.max(P.prior, 0.02) });
    mdp.rubric = { input: { net_profit_usd: netProfit, p_trap: bayes.p_trap, gamma: P.gamma }, steps: mdp.steps, output: { recommended_action: mdp.recommended_action, policy: mdp.policy, Q: mdp.Q }, explanation: mdp.explanation };
    const action = mdp.recommended_action, legs = best ? best.legs : [];
    const status = { EXECUTE_FLASH_SWAP: 'BROADCAST_PUBLIC_MEMPOOL', PRIVATE_RPC_PROTECT: 'PRIVATE_BUNDLE_SUBMITTED', ABORT_AND_WAIT: 'CAPITAL_HELD_NEXT_BLOCK' }[action];
    const execution = { action, status, route: best ? best.route : [], legs, flash_loan: { asset: start, amount: best ? best.start_amount : 0, usd: cap, repay: best ? best.start_amount : 0 },
      expected_value_usd: mdp.belief_q[action], bribe_usd: action === 'PRIVATE_RPC_PROTECT' ? mdp.derived.bribe : 0, atomic: action !== 'ABORT_AND_WAIT' && profitable,
      verdict: best && action !== 'ABORT_AND_WAIT' ? `${action} on ${best.route.join(' → ')}` : 'Hold: no transaction is broadcast this block.' };
    if (action !== 'ABORT_AND_WAIT' && !profitable) execution.verdict = 'MDP picked a broadcast action although no profitable cycle exists (check parameters).';
    const sc = D.SCENARIOS[P.scenario], tokens = {}; for (const t of TOKEN_LIST) tokens[t] = { name: TOKENS[t].name, price: market.prices[t], color: TOKENS[t].color };
    return { params: P, scenario: { id: sc.id, name: sc.name, short: sc.short, blurb: sc.blurb }, tokens,
      pools: market.pools.map((p) => ({ id: p.id, a: p.a, b: p.b, protocol: p.protocol, fee: p.fee, fee_pct: Math.round(p.fee * 1e5) / 1e3, tvl_usd: p.tvl_usd, dev_bps: p.dev_bps, reserve_a: p.reserve_a, reserve_b: p.reserve_b, gas_units: p.gas_units, color: p.color })),
      pool_metrics: poolMetrics(market, cap, new Set(best ? best.pools : []), bayes.p_trap, P.sensors), protocol_colors: D.PROTOCOL_COLORS,
      astar, bfs, bayes, mdp, execution, profitable, fallback, elapsed_ms: performance.now() - t0 };
  }

  const API = { runPipeline, Market, astarSearch, bfsSearch, infer, solveMdp };
  root.QuasarEngine = API; root.QUASAR_LOCAL = runPipeline;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);

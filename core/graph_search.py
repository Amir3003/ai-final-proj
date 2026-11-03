"""Algorithm 1 — Informed graph search (A*) with a BFS baseline for DEX arbitrage cycles.

Model
-----
* Nodes  = tokens, directed edges = (pool, direction).  14 pools -> 28 directed edges.
* Every pool is a constant-product AMM.  With fee phi and retention kappa = 1 - phi
  (the "gamma" of the task statement; renamed to avoid a clash with the MDP discount):
        dy = y * kappa*dx / (x + kappa*dx)
* Gas drag is deducted on the output side of every hop:  out_net = dy - gas_usd / price_out.
* Effective (numeraire-normalised) rate of a hop:
        r_eff = value_out_net / value_in           (values in USD at oracle prices)
  and the additive edge weight is  w = -ln(r_eff).   Along a path the weights telescope:
        g(path) = sum w = -ln(final_value / start_value)       (g < 0  <=>  profit)
* Heuristic h(n,k): idealised best return to the start token within k remaining hops using
  spot rates only (no price impact, no gas).  Real hops can only be worse, so h never
  over-estimates the remaining cost  ->  admissible  ->  A* returns the optimal cycle.
"""
from __future__ import annotations

import heapq
import itertools
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# --------------------------------------------------------------------------------------
# Static universe
# --------------------------------------------------------------------------------------
TOKENS: Dict[str, dict] = {
    "ETH":  {"name": "Ethereum",  "price": 3000.0,  "color": "#00F0FF"},
    "USDC": {"name": "USD Coin",  "price": 1.0,     "color": "#00FF9D"},
    "WBTC": {"name": "Wrapped BTC", "price": 65000.0, "color": "#FFB800"},
    "SOL":  {"name": "Solana",    "price": 160.0,   "color": "#9D00FF"},
    "ARB":  {"name": "Arbitrum",  "price": 0.90,    "color": "#4DA3FF"},
    "LINK": {"name": "Chainlink", "price": 15.0,    "color": "#6C8CFF"},
    "UNI":  {"name": "Uniswap",   "price": 8.0,     "color": "#FF4FD8"},
    "AAVE": {"name": "Aave",      "price": 120.0,   "color": "#B6E3FF"},
}

PROTOCOL_GAS_UNITS = {"Uniswap V3": 130_000, "Curve": 220_000, "Balancer": 160_000, "SushiSwap": 115_000}
PROTOCOL_COLORS = {"Uniswap V3": "#FF4FD8", "Curve": "#FFB800", "Balancer": "#4DA3FF", "SushiSwap": "#00FF9D"}
# structural MEV attractiveness of a venue (used for the X-ray "mempool radiation" layer)
PROTOCOL_MEV_BASE = {"Uniswap V3": 0.55, "Curve": 0.22, "Balancer": 0.32, "SushiSwap": 0.45}

# (id, token_a, token_b, protocol, fee, tvl_usd)
POOL_DEFS: List[Tuple[str, str, str, str, float, float]] = [
    ("P01", "ETH",  "USDC", "Uniswap V3", 0.0005, 60e6),
    ("P02", "ETH",  "USDC", "SushiSwap",  0.0030, 12e6),
    ("P03", "ETH",  "WBTC", "Curve",      0.0005, 30e6),
    ("P04", "WBTC", "USDC", "Uniswap V3", 0.0030, 25e6),
    ("P05", "SOL",  "USDC", "Balancer",   0.0030, 20e6),
    ("P06", "SOL",  "ETH",  "SushiSwap",  0.0030, 14e6),
    ("P07", "ARB",  "ETH",  "Uniswap V3", 0.0030, 8e6),
    ("P08", "ARB",  "USDC", "Uniswap V3", 0.0030, 9e6),
    ("P09", "LINK", "ETH",  "Balancer",   0.0030, 7e6),
    ("P10", "LINK", "USDC", "SushiSwap",  0.0030, 5e6),
    ("P11", "UNI",  "ETH",  "Uniswap V3", 0.0030, 6e6),
    ("P12", "UNI",  "USDC", "Uniswap V3", 0.0100, 3e6),
    ("P13", "AAVE", "ETH",  "Balancer",   0.0030, 5e6),
    ("P14", "AAVE", "USDC", "Curve",      0.0005, 8e6),
]

# Market snapshots: per-pool mispricing in bps.  dev > 0  =>  pool pays `dev` bps MORE of
# token_b per token_a than the oracle (a->b gains, b->a loses).
MARKET_PROFILES: Dict[str, Dict[str, float]] = {
    "baseline": {},   # filled in below
}


@dataclass
class Pool:
    id: str
    a: str
    b: str
    protocol: str
    fee: float
    tvl_usd: float
    dev_bps: float
    reserve_a: float
    reserve_b: float
    gas_units: int

    @property
    def kappa(self) -> float:
        return 1.0 - self.fee

    def other(self, token: str) -> str:
        return self.b if token == self.a else self.a

    def reserves(self, token_in: str) -> Tuple[float, float]:
        return (self.reserve_a, self.reserve_b) if token_in == self.a else (self.reserve_b, self.reserve_a)

    def to_dict(self) -> dict:
        return {"id": self.id, "a": self.a, "b": self.b, "protocol": self.protocol, "fee": self.fee,
                "fee_pct": round(self.fee * 100, 3), "tvl_usd": self.tvl_usd, "dev_bps": self.dev_bps,
                "reserve_a": self.reserve_a, "reserve_b": self.reserve_b, "gas_units": self.gas_units,
                "color": PROTOCOL_COLORS[self.protocol]}


@dataclass
class Edge:
    pool: Pool
    src: str
    dst: str


class Market:
    """A snapshot: oracle prices, pools with reserves, and a gas price."""

    def __init__(self, profile: Dict[str, float] | None = None, gas_gwei: float = 20.0,
                 dislocation_scale: float = 1.0, prices: Dict[str, float] | None = None):
        self.prices = {t: v["price"] for t, v in TOKENS.items()}
        if prices:
            self.prices.update(prices)
        self.gas_gwei = float(gas_gwei)
        self.pools: List[Pool] = []
        profile = profile or {}
        for pid, a, b, proto, fee, tvl in POOL_DEFS:
            dev = float(profile.get(pid, 0.0)) * dislocation_scale
            ra = tvl / 2.0 / self.prices[a]
            rb = tvl / 2.0 / self.prices[b] * (1.0 + dev / 1e4)
            self.pools.append(Pool(pid, a, b, proto, fee, tvl, dev, ra, rb, PROTOCOL_GAS_UNITS[proto]))
        self.pool_by_id = {p.id: p for p in self.pools}
        self.edges: List[Edge] = []
        self.adj: Dict[str, List[Edge]] = {t: [] for t in TOKENS}
        for p in self.pools:
            for s, d in ((p.a, p.b), (p.b, p.a)):
                e = Edge(p, s, d)
                self.edges.append(e)
                self.adj[s].append(e)

    # ---- primitives ------------------------------------------------------------------
    def gas_usd(self, pool: Pool) -> float:
        return pool.gas_units * self.gas_gwei * 1e-9 * self.prices["ETH"]

    @staticmethod
    def amm_out(x: float, y: float, kappa: float, dx: float) -> float:
        """Constant-product output with fee retention kappa: dy = y*kappa*dx/(x + kappa*dx)."""
        if dx <= 0:
            return 0.0
        return y * kappa * dx / (x + kappa * dx)

    def spot_value_ratio(self, e: Edge) -> float:
        """Zero-size, zero-gas value ratio of an edge (the 'book rate' used by h)."""
        x, y = e.pool.reserves(e.src)
        return e.pool.kappa * (y / x) * self.prices[e.dst] / self.prices[e.src]

    def hop(self, e: Edge, amount_in: float) -> dict:
        x, y = e.pool.reserves(e.src)
        gross = self.amm_out(x, y, e.pool.kappa, amount_in)
        gas_usd = self.gas_usd(e.pool)
        net = gross - gas_usd / self.prices[e.dst]
        spot_out = e.pool.kappa * (y / x) * amount_in
        impact = 1.0 - gross / spot_out if spot_out > 0 else 0.0
        v_in = amount_in * self.prices[e.src]
        v_out = net * self.prices[e.dst]
        r_eff = v_out / v_in if v_in > 0 and v_out > 0 else 0.0
        return {"from": e.src, "to": e.dst, "pool": e.pool.id, "protocol": e.pool.protocol,
                "fee_pct": round(e.pool.fee * 100, 3), "amount_in": amount_in, "amount_out_gross": gross,
                "gas_usd": gas_usd, "amount_out_net": net, "price_impact_pct": impact * 100,
                "r_eff": r_eff, "weight": (-math.log(r_eff) if r_eff > 0 else math.inf)}

    def evaluate_cycle(self, start: str, edges: List[Edge], capital_usd: float) -> dict:
        amount = capital_usd / self.prices[start]
        a0 = amount
        legs = []
        for e in edges:
            h = self.hop(e, amount)
            legs.append(h)
            amount = h["amount_out_net"]
            if amount <= 0:
                break
        profit = (amount - a0) * self.prices[start] if amount > 0 else -capital_usd
        return {"legs": legs, "final_amount": amount, "start_amount": a0, "profit_usd": profit,
                "gas_total_usd": sum(l["gas_usd"] for l in legs),
                "profit_bps": profit / capital_usd * 1e4}


# --------------------------------------------------------------------------------------
# Heuristic table
# --------------------------------------------------------------------------------------
def build_heuristic(market: Market, start: str, max_hops: int) -> Dict[int, Dict[str, float]]:
    """best[k][t] = max product of spot value-ratios over walks t -> ... -> start of 1..k hops."""
    best: Dict[int, Dict[str, float]] = {0: {t: 0.0 for t in TOKENS}}
    for k in range(1, max_hops + 1):
        cur = {}
        for t in TOKENS:
            m = 0.0
            for e in market.adj[t]:
                rho = market.spot_value_ratio(e)
                cont = 1.0 if e.dst == start else 0.0
                cont = max(cont, best[k - 1][e.dst])
                m = max(m, rho * cont)
            cur[t] = m
        best[k] = cur
    return best


def h_cost(best, token: str, hops_left: int) -> float:
    v = best[hops_left][token] if hops_left >= 1 else 0.0
    return -math.log(v) if v > 0 else math.inf


# --------------------------------------------------------------------------------------
# Search nodes
# --------------------------------------------------------------------------------------
@dataclass(order=False)
class Node:
    tokens: Tuple[str, ...]
    edges: Tuple[Edge, ...]
    amount: float
    g: float
    h: float = 0.0
    legs: Tuple[dict, ...] = ()

    @property
    def f(self) -> float:
        return self.g + self.h

    @property
    def hops(self) -> int:
        return len(self.edges)

    @property
    def token(self) -> str:
        return self.tokens[-1]

    def label(self) -> str:
        return "→".join(self.tokens)


def _children(market: Market, node: Node, start: str, capital_usd: float, max_hops: int, min_hops: int):
    used_pools = {e.pool.id for e in node.edges}
    for e in market.adj[node.token]:
        if e.pool.id in used_pools:
            continue
        closing = e.dst == start
        if closing and node.hops + 1 < min_hops:
            continue
        if not closing and (e.dst in node.tokens or node.hops + 1 >= max_hops):
            continue
        h = market.hop(e, node.amount)
        if h["amount_out_net"] <= 0:
            continue
        v_in = node.amount * market.prices[e.src]
        v_out = h["amount_out_net"] * market.prices[e.dst]
        yield e, h, v_in, v_out


def _make_child(market, node, e, h, start, capital_usd):
    start_value = capital_usd
    v_now = h["amount_out_net"] * market.prices[e.dst]
    g = -math.log(v_now / start_value)
    return Node(node.tokens + (e.dst,), node.edges + (e,), h["amount_out_net"], g, 0.0, node.legs + (h,))


def _result_from_node(market: Market, start: str, node: Node, capital_usd: float) -> dict:
    ev = market.evaluate_cycle(start, list(node.edges), capital_usd)
    ev["route"] = list(node.tokens)
    ev["pools"] = [e.pool.id for e in node.edges]
    ev["hops"] = node.hops
    ev["total_weight"] = sum(l["weight"] for l in ev["legs"])
    return ev


# --------------------------------------------------------------------------------------
# A*
# --------------------------------------------------------------------------------------
def astar_search(market: Market, start: str = "USDC", capital_usd: float = 50_000.0, max_hops: int = 4,
                 min_hops: int = 2, prune_unprofitable: bool = True, trace_open_k: int = 6,
                 trace_limit: int = 400) -> dict:
    best = build_heuristic(market, start, max_hops)
    amount0 = capital_usd / market.prices[start]
    root = Node((start,), (), amount0, 0.0)
    root.h = h_cost(best, start, max_hops)
    counter = itertools.count()
    open_heap: List[tuple] = []
    heapq.heappush(open_heap, (root.f, 0, next(counter), root))
    trace: List[dict] = []
    expanded = generated = pruned = 0
    goal: Optional[Node] = None

    if prune_unprofitable and root.f > 0:
        pruned += 1
        open_heap.clear()  # even the idealised best cycle loses money -> provably no profit
        trace.append({"step": 0, "event": "ROOT_PRUNED", "path": start, "g": 0.0, "h": root.h, "f": root.f,
                      "open_set": [], "children": []})

    while open_heap:
        f, _, _, node = heapq.heappop(open_heap)
        if node.token == start and node.hops >= min_hops:
            goal = node
            if len(trace) < trace_limit:
                trace.append({"step": expanded + 1, "event": "GOAL", "path": node.label(), "tokens": list(node.tokens),
                              "g": node.g, "h": 0.0, "f": node.f, "hops": node.hops, "open_set": [], "children": []})
            break
        expanded += 1
        kids = []
        for e, h, v_in, v_out in _children(market, node, start, capital_usd, max_hops, min_hops):
            child = _make_child(market, node, e, h, start, capital_usd)
            hops_left = max_hops - child.hops
            child.h = 0.0 if child.token == start else h_cost(best, child.token, hops_left)
            generated += 1
            keep = not (prune_unprofitable and child.f > 1e-12) and math.isfinite(child.f)
            kids.append({"path": child.label(), "pool": e.pool.id, "g": child.g, "h": child.h, "f": child.f,
                         "kept": keep})
            if keep:
                heapq.heappush(open_heap, (child.f, child.hops, next(counter), child))
            else:
                pruned += 1
        if len(trace) < trace_limit:
            snapshot = sorted(open_heap)[:trace_open_k]
            trace.append({"step": expanded, "event": "EXPAND", "path": node.label(), "tokens": list(node.tokens),
                          "g": node.g, "h": node.h, "f": node.f, "hops": node.hops,
                          "last_pool": node.edges[-1].pool.id if node.edges else None,
                          "open_size": len(open_heap),
                          "open_set": [{"path": n.label(), "g": n.g, "h": n.h, "f": n.f} for _, _, _, n in snapshot],
                          "children": kids})

    res = {"algorithm": "A*", "start": start, "capital_usd": capital_usd, "max_hops": max_hops,
           "expanded": expanded, "generated": generated, "pruned": pruned, "found": goal is not None,
           "trace": trace, "trace_truncated": expanded > trace_limit,
           "heuristic": {"definition": "h(n,k) = -ln(best idealised spot return to start within k hops)",
                         "root_h": root.h}}
    if goal is not None:
        res["best"] = _result_from_node(market, start, goal, capital_usd)
        res["best"]["f"] = goal.f
    return res


# --------------------------------------------------------------------------------------
# BFS baseline (uninformed, exhaustive up to max_hops)
# --------------------------------------------------------------------------------------
def bfs_search(market: Market, start: str = "USDC", capital_usd: float = 50_000.0, max_hops: int = 4,
               min_hops: int = 2) -> dict:
    from collections import deque
    amount0 = capital_usd / market.prices[start]
    q = deque([Node((start,), (), amount0, 0.0)])
    expanded = generated = 0
    best_node: Optional[Node] = None
    first_profitable_at: Optional[int] = None
    cycles_found = 0
    while q:
        node = q.popleft()
        if node.token == start and node.hops >= min_hops:
            cycles_found += 1
            if best_node is None or node.g < best_node.g:
                best_node = node
            if node.g < 0 and first_profitable_at is None:
                first_profitable_at = expanded
            continue
        expanded += 1
        for e, h, _, _ in _children(market, node, start, capital_usd, max_hops, min_hops):
            child = _make_child(market, node, e, h, start, capital_usd)
            generated += 1
            q.append(child)
    res = {"algorithm": "BFS", "start": start, "expanded": expanded, "generated": generated,
           "cycles_found": cycles_found, "first_profitable_at_expansion": first_profitable_at,
           "found": best_node is not None}
    if best_node is not None:
        res["best"] = _result_from_node(market, start, best_node, capital_usd)
    return res


def brute_force_best(market: Market, start: str, capital_usd: float, max_hops: int, min_hops: int = 2):
    """Independent exhaustive DFS used by the test-suite as ground truth."""
    best = [None, -math.inf]

    def dfs(token, amount, visited, used, depth, tokens):
        for e in market.adj[token]:
            if e.pool.id in used:
                continue
            closing = e.dst == start
            if closing and depth + 1 < min_hops:
                continue
            if not closing and (e.dst in visited or depth + 1 >= max_hops):
                continue
            h = market.hop(e, amount)
            if h["amount_out_net"] <= 0:
                continue
            if closing:
                profit = (h["amount_out_net"] - capital_usd / market.prices[start]) * market.prices[start]
                if profit > best[1]:
                    best[0], best[1] = tokens + [e.dst], profit
            else:
                dfs(e.dst, h["amount_out_net"], visited | {e.dst}, used | {e.pool.id}, depth + 1, tokens + [e.dst])

    dfs(start, capital_usd / market.prices[start], {start}, frozenset(), 0, [start])
    return best[0], best[1]


def compare_explanation(astar: dict, bfs: dict) -> str:
    if not astar.get("found"):
        return (f"A* proved in {astar['expanded']} expansions that even the idealised best cycle (zero impact, zero gas) "
                f"cannot beat break-even, while uninformed BFS had to enumerate {bfs['expanded']} partial routes to learn the same.")
    ea, eb = astar["expanded"], bfs["expanded"]
    same = abs(astar["best"]["profit_usd"] - bfs["best"]["profit_usd"]) < 1e-6
    ratio = eb / max(ea, 1)
    if ea < eb:
        return (f"A* expanded {ea} nodes versus {eb} for BFS ({ratio:.1f}× fewer) because h(n) — the best idealised "
                f"return to the start token — let it discard every branch whose optimistic f(n)=g(n)+h(n) was already unprofitable, "
                f"and it {'matched' if same else 'did NOT match'} BFS's optimal cycle.")
    return (f"On this tiny graph A* expanded {ea} nodes versus {eb} for BFS: the admissible bound pruned little, "
            f"but the optimal cycle is identical ({'yes' if same else 'NO'}), which is exactly the guarantee admissibility gives.")

# Placeholder profiles, tuned below by tools/tune (see MARKET_PROFILES assignment at import time)
from .market_profiles import PROFILES as _P  # noqa: E402
MARKET_PROFILES.update(_P)

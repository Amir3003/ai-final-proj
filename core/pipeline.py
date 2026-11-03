"""Unified orchestrator:  A* (graph search)  ->  Bayes (mempool risk)  ->  MDP (decision)  ->  atomic execution plan."""
from __future__ import annotations

import time
from typing import Any, Dict, Optional

from .graph_search import (Market, MARKET_PROFILES, PROTOCOL_MEV_BASE, PROTOCOL_COLORS, TOKENS, astar_search,
                           bfs_search, compare_explanation)
from .bayesian_mempool import infer, SENSORS
from .mdp_controller import MDPParams, solve, ACTIONS

SENSOR_KEYS = list(SENSORS.keys())

SCENARIOS: Dict[str, dict] = {
    "alpha": {"id": "alpha", "name": "Scenario Alpha: Tranquil Nebula", "short": "ALPHA · Tranquil Nebula",
              "blurb": "Low gas, clean mempool → high-profit route → low Bayesian risk → EXECUTE.",
              "market": "alpha", "capital": 50_000, "gas_gwei": 12, "prior": 0.05, "gamma": 0.95, "dislocation": 1.0,
              "sensors": {"gas_priority_spike": False, "mev_bot_signature": False, "pool_imbalance_shock": False}},
    "beta": {"id": "beta", "name": "Scenario Beta: MEV Supernova Trap", "short": "BETA · MEV Supernova Trap",
             "blurb": "Fat apparent profit, but gas spike + MEV bot signature → posterior > 82% → MDP overrides greed.",
             "market": "beta", "capital": 100_000, "gas_gwei": 28, "prior": 0.15, "gamma": 0.95, "dislocation": 1.0,
             "sensors": {"gas_priority_spike": True, "mev_bot_signature": True, "pool_imbalance_shock": False}},
    "gamma": {"id": "gamma", "name": "Scenario Gamma: Gas Storm Eclipse", "short": "GAMMA · Gas Storm Eclipse",
              "blurb": "Extreme gas erodes thin 3-hop cycles; A* prunes them and finds a deeper 4-hop wormhole.",
              "market": "gamma", "capital": 40_000, "gas_gwei": 250, "prior": 0.10, "gamma": 0.95, "dislocation": 1.0,
              "sensors": {"gas_priority_spike": True, "mev_bot_signature": False, "pool_imbalance_shock": False}},
    "delta": {"id": "delta", "name": "Scenario Delta: Custom Manual Override", "short": "DELTA · Manual Override",
              "blurb": "Sliders for capital, prior, gas, discount factor and sensor toggles.",
              "market": "alpha", "capital": 50_000, "gas_gwei": 20, "prior": 0.10, "gamma": 0.95, "dislocation": 1.0,
              "sensors": {"gas_priority_spike": False, "mev_bot_signature": False, "pool_imbalance_shock": False}},
}


def resolve_params(req: Optional[dict]) -> dict:
    req = dict(req or {})
    base = dict(SCENARIOS[req.get("scenario", "alpha")] if req.get("scenario", "alpha") in SCENARIOS else SCENARIOS["alpha"])
    base["sensors"] = dict(base["sensors"])
    for k in ("capital", "gas_gwei", "prior", "gamma", "dislocation"):
        if req.get(k) is not None:
            base[k] = float(req[k])
    if isinstance(req.get("sensors"), dict):
        for k in SENSOR_KEYS:
            if k in req["sensors"]:
                base["sensors"][k] = bool(req["sensors"][k])
    if req.get("market"):
        base["market"] = req["market"]
    if req.get("start") in TOKENS:
        base["start"] = req["start"]
    base.setdefault("start", "USDC")
    base["capital"] = min(max(base["capital"], 1_000), 250_000)
    base["gas_gwei"] = min(max(base["gas_gwei"], 1), 1000)
    base["prior"] = min(max(base["prior"], 0.0), 1.0)
    base["gamma"] = min(max(base["gamma"], 0.0), 0.999)
    base["dislocation"] = min(max(base["dislocation"], 0.0), 5.0)
    base["scenario"] = base["id"]
    return base


def _pool_metrics(market: Market, capital: float, route_pools, p_trap: float, sensors: Dict[str, bool]):
    metrics = []
    hot = 0.0
    if sensors.get("mev_bot_signature"):
        hot += 0.25
    if sensors.get("gas_priority_spike"):
        hot += 0.15
    for p in market.pools:
        x, y = p.reserve_a, p.reserve_b
        dx = capital / market.prices[p.a]
        out = market.amm_out(x, y, p.kappa, dx)
        impact = 1.0 - out / (p.kappa * (y / x) * dx)
        thin = min(1.0, (capital / p.tvl_usd) * 12)
        mev = PROTOCOL_MEV_BASE[p.protocol] * (0.55 + 0.45 * thin) + hot * (0.6 if p.protocol != "Curve" else 0.3)
        if p.id in route_pools:
            mev += 0.9 * p_trap * (1.0 - mev)
        metrics.append({"id": p.id, "slippage_pct": impact * 100, "mev_exposure": min(1.0, mev),
                        "gas_usd": market.gas_usd(p), "depth_usd": p.tvl_usd})
    return metrics


def run_pipeline(req: Optional[dict] = None) -> dict:
    t0 = time.perf_counter()
    P = resolve_params(req)
    market = Market(MARKET_PROFILES[P["market"]], gas_gwei=P["gas_gwei"], dislocation_scale=P["dislocation"])
    start, cap = P["start"], P["capital"]

    # ---- Stage 1: A* + BFS -----------------------------------------------------------
    astar = astar_search(market, start, cap, max_hops=4, prune_unprofitable=True)
    fallback = False
    if not astar["found"]:                   # no profitable cycle: look for the least-bad one for display
        full = astar_search(market, start, cap, max_hops=4, prune_unprofitable=False)
        astar["fallback_best"] = full.get("best")
        astar["fallback_expanded"] = full["expanded"]
        fallback = True
    bfs = bfs_search(market, start, cap, max_hops=4)
    best = astar.get("best") or astar.get("fallback_best")
    profitable = bool(astar["found"] and best and best["profit_usd"] > 0)
    net_profit = best["profit_usd"] if (profitable) else 0.0
    gas_total = best["gas_total_usd"] if best else 0.0
    astar["profitable"] = profitable
    astar["explanation"] = compare_explanation(astar, bfs)
    astar["rubric"] = {
        "input": {"tokens": len(TOKENS), "directed_edges": len(market.edges), "start": start, "capital_usd": cap,
                  "gas_gwei": P["gas_gwei"], "max_hops": 4},
        "steps": [f"w(u→v) = -ln r_eff(u→v) with constant-product impact and gas drag on {len(market.edges)} directed edges",
                  f"h(n,k) = -ln(best idealised spot return to {start} within k hops); root h = {astar['heuristic']['root_h']:.5f}",
                  f"Priority-queue expansions: {astar['expanded']} (generated {astar['generated']}, pruned {astar['pruned']})",
                  (f"Goal popped: {' → '.join(best['route'])} with g = {best['total_weight']:.6f}" if best else "No cycle")],
        "output": ({"route": best["route"], "pools": best["pools"], "net_profit_usd": best["profit_usd"],
                    "profit_bps": best["profit_bps"], "gas_usd": best["gas_total_usd"]} if best else None),
        "explanation": astar["explanation"]}
    bfs["explanation"] = "BFS expands every partial route level by level without any estimate of what lies ahead."

    # ---- Stage 2: Bayes --------------------------------------------------------------
    bayes = infer(P["prior"], P["sensors"])
    bayes["rubric"] = {"input": {"prior_h1": P["prior"], "sensors": P["sensors"]},
                       "steps": bayes["steps"], "output": {"posterior_h1": bayes["posterior_h1"]},
                       "explanation": bayes["explanation"]}

    # ---- Stage 3: MDP ----------------------------------------------------------------
    mdp = solve(MDPParams(net_profit=net_profit, gas_total=gas_total, capital=cap, p_trap=bayes["p_trap"],
                          gamma=P["gamma"], onset=max(P["prior"], 0.02)))
    mdp["rubric"] = {"input": {"net_profit_usd": net_profit, "p_trap": bayes["p_trap"], "gamma": P["gamma"]},
                     "steps": mdp["steps"],
                     "output": {"recommended_action": mdp["recommended_action"], "policy": mdp["policy"],
                                "Q": mdp["Q"]},
                     "explanation": mdp["explanation"]}

    # ---- Stage 4: atomic execution plan -------------------------------------------------
    action = mdp["recommended_action"]
    legs = best["legs"] if best else []
    status = {"EXECUTE_FLASH_SWAP": "BROADCAST_PUBLIC_MEMPOOL", "PRIVATE_RPC_PROTECT": "PRIVATE_BUNDLE_SUBMITTED",
              "ABORT_AND_WAIT": "CAPITAL_HELD_NEXT_BLOCK"}[action]
    execution = {
        "action": action, "status": status, "route": best["route"] if best else [], "legs": legs,
        "flash_loan": {"asset": start, "amount": best["start_amount"] if best else 0.0, "usd": cap,
                       "repay": best["start_amount"] if best else 0.0},
        "expected_value_usd": mdp["belief_q"][action], "bribe_usd": mdp["derived"]["bribe"] if action == "PRIVATE_RPC_PROTECT" else 0.0,
        "atomic": action != "ABORT_AND_WAIT" and profitable,
        "verdict": (f"{action} on {' → '.join(best['route'])}" if best and action != "ABORT_AND_WAIT"
                    else "Hold: no transaction is broadcast this block."),
    }
    if action != "ABORT_AND_WAIT" and not profitable:
        execution["verdict"] = "MDP picked a broadcast action although no profitable cycle exists (check parameters)."

    route_pools = set(best["pools"]) if best else set()
    return {
        "params": P, "scenario": {k: SCENARIOS[P["scenario"]][k] for k in ("id", "name", "short", "blurb")},
        "tokens": {t: {"name": v["name"], "price": market.prices[t], "color": v["color"]} for t, v in TOKENS.items()},
        "pools": [p.to_dict() for p in market.pools],
        "pool_metrics": _pool_metrics(market, cap, route_pools, bayes["p_trap"], P["sensors"]),
        "protocol_colors": PROTOCOL_COLORS,
        "astar": astar, "bfs": bfs, "bayes": bayes, "mdp": mdp, "execution": execution,
        "profitable": profitable, "fallback": fallback, "elapsed_ms": (time.perf_counter() - t0) * 1000,
    }

import math
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core.graph_search import (Market, MARKET_PROFILES, POOL_DEFS, TOKENS, astar_search, bfs_search, brute_force_best,
                               build_heuristic)
from core.bayesian_mempool import infer, SENSORS
from core.mdp_controller import MDPParams, solve, build_model, value_iteration, one_step_eu, ACTIONS
from core.pipeline import run_pipeline, SCENARIOS

SCEN = [("alpha", 12, 50_000), ("beta", 28, 100_000), ("gamma", 250, 40_000)]


# ------------------------------------------------------------------ graph / AMM -----
def test_graph_has_8_tokens_and_18plus_directed_edges():
    m = Market({}, 20)
    assert len(TOKENS) == 8 and len(m.edges) >= 18 and len(m.edges) == 2 * len(POOL_DEFS)


def test_amm_formula_matches_closed_form():
    dy = Market.amm_out(1000.0, 2000.0, 0.997, 10.0)
    assert dy == pytest.approx(2000 * 0.997 * 10 / (1000 + 0.997 * 10))


def test_amm_price_impact_monotone_and_below_spot():
    outs = [Market.amm_out(1e6, 1e6, 0.997, d) for d in (1e2, 1e3, 1e4, 1e5)]
    rates = [o / d for o, d in zip(outs, (1e2, 1e3, 1e4, 1e5))]
    assert all(r1 > r2 for r1, r2 in zip(rates, rates[1:])) and rates[0] < 0.997


def test_edge_weight_is_negative_log_effective_rate():
    m = Market({}, 20)
    h = m.hop(m.adj["USDC"][0], 10_000.0)
    assert h["weight"] == pytest.approx(-math.log(h["r_eff"]))
    assert h["gas_usd"] > 0 and h["r_eff"] < 1


def test_path_weights_telescope_to_log_profit():
    m = Market(MARKET_PROFILES["alpha"], 12)
    res = astar_search(m, "USDC", 50_000)
    b = res["best"]
    assert b["total_weight"] == pytest.approx(-math.log((50_000 + b["profit_usd"]) / 50_000), abs=1e-9)


@pytest.mark.parametrize("name,gas,cap", SCEN)
def test_astar_matches_bruteforce_optimum(name, gas, cap):
    m = Market(MARKET_PROFILES[name], gas)
    a = astar_search(m, "USDC", cap, prune_unprofitable=False)
    route, profit = brute_force_best(m, "USDC", cap, 4)
    assert a["best"]["profit_usd"] == pytest.approx(profit, rel=1e-9)
    assert a["best"]["route"] == route


@pytest.mark.parametrize("name,gas,cap", SCEN)
def test_astar_with_pruning_still_optimal_and_equals_bfs(name, gas, cap):
    m = Market(MARKET_PROFILES[name], gas)
    a = astar_search(m, "USDC", cap, prune_unprofitable=True)
    b = bfs_search(m, "USDC", cap)
    assert a["found"] and a["best"]["profit_usd"] == pytest.approx(b["best"]["profit_usd"], rel=1e-9)
    assert a["expanded"] < b["expanded"]


def test_astar_optimal_from_eth_start_too():
    m = Market(MARKET_PROFILES["beta"], 28)
    a = astar_search(m, "ETH", 60_000, prune_unprofitable=False)
    route, profit = brute_force_best(m, "ETH", 60_000, 4)
    assert a["best"]["profit_usd"] == pytest.approx(profit, rel=1e-9)


def test_heuristic_is_admissible_for_every_expanded_node():
    m = Market(MARKET_PROFILES["gamma"], 250)
    res = astar_search(m, "USDC", 40_000, prune_unprofitable=False, trace_limit=10_000)
    opt = res["best"]["total_weight"]
    for t in res["trace"]:
        if t["event"] == "EXPAND":
            assert t["f"] <= opt + 1e-9      # f never exceeds the true optimal cost


def test_heuristic_monotone_in_hops_left():
    m = Market(MARKET_PROFILES["alpha"], 12)
    best = build_heuristic(m, "USDC", 4)
    for t in TOKENS:
        for k in range(1, 4):
            assert best[k + 1][t] >= best[k][t] - 1e-15


def test_trace_contains_g_h_f_and_open_set():
    res = astar_search(Market(MARKET_PROFILES["alpha"], 12), "USDC", 50_000)
    ex = [t for t in res["trace"] if t["event"] == "EXPAND"][0]
    assert {"g", "h", "f", "open_set", "children"} <= ex.keys()
    assert all(abs(t["f"] - (t["g"] + t["h"])) < 1e-12 for t in res["trace"] if t["event"] == "EXPAND")


def test_negative_profit_market_has_no_profitable_cycle_and_pipeline_aborts():
    r = run_pipeline({"scenario": "delta", "dislocation": 0.0})
    assert not r["astar"]["found"] and not r["profitable"]
    assert r["astar"]["fallback_best"]["profit_usd"] < 0
    assert r["mdp"]["recommended_action"] == "ABORT_AND_WAIT"
    assert r["execution"]["atomic"] is False


def test_gas_storm_erodes_marginal_cycle():
    p = {"P04": -40, "P03": -20, "P01": 25}
    lo = astar_search(Market(p, 10), "USDC", 20_000)
    hi = astar_search(Market(p, 400), "USDC", 20_000)
    assert lo["found"] and not hi["found"]


def test_gamma_scenario_prefers_four_hop_route():
    r = run_pipeline({"scenario": "gamma"})
    assert r["astar"]["best"]["hops"] == 4


# ------------------------------------------------------------------ bayes -----------
def test_bayes_hand_computed_example():
    out = infer(0.15, {"gas_priority_spike": True, "mev_bot_signature": True, "pool_imbalance_shock": False})
    L1, L0 = 0.7 * 0.88 * 0.4, 0.15 * 0.04 * 0.88
    assert out["likelihood_h1"] == pytest.approx(L1) and out["likelihood_h0"] == pytest.approx(L0)
    assert out["marginal"] == pytest.approx(L1 * .15 + L0 * .85)
    assert out["posterior_h1"] == pytest.approx(L1 * .15 / (L1 * .15 + L0 * .85))


def test_bayes_sequential_equals_batch():
    out = infer(0.3, {"gas_priority_spike": True, "mev_bot_signature": False, "pool_imbalance_shock": True})
    assert out["sequential_matches_batch"] and out["sequential"][-1]["posterior"] == pytest.approx(out["posterior_h1"])


@pytest.mark.parametrize("prior", [0.0, 0.01, 0.2, 0.5, 0.99, 1.0])
@pytest.mark.parametrize("bits", [(0, 0, 0), (1, 0, 0), (1, 1, 0), (1, 1, 1), (0, 1, 0)])
def test_bayes_probability_axioms(prior, bits):
    r = {k: bool(b) for k, b in zip(SENSORS, bits)}
    o = infer(prior, r)
    assert 0 <= o["posterior_h1"] <= 1 and 0 < o["marginal"] <= 1
    assert o["posterior_h1"] + o["posterior_h0"] == pytest.approx(1.0)


def test_bayes_no_evidence_returns_prior_and_firing_raises_belief():
    assert infer(0.2, {})["posterior_h1"] == pytest.approx(0.2)
    assert infer(0.2, {"mev_bot_signature": True})["posterior_h1"] > 0.2
    assert infer(0.2, {"mev_bot_signature": False})["posterior_h1"] < 0.2


def test_bayes_rejects_invalid_prior():
    with pytest.raises(ValueError):
        infer(1.2, {})


def test_scenario_alpha_low_beta_over_82_percent():
    assert run_pipeline({"scenario": "alpha"})["bayes"]["p_trap"] < 0.05
    assert run_pipeline({"scenario": "beta"})["bayes"]["p_trap"] > 0.82


# ------------------------------------------------------------------ mdp -------------
def _mdp(**kw):
    base = dict(net_profit=1000.0, gas_total=40.0, capital=50_000.0, p_trap=0.1)
    base.update(kw)
    return MDPParams(**base)


def test_mdp_transition_rows_are_stochastic():
    T, _ = build_model(_mdp())
    for row in T.values():
        assert sum(p for p, _ in row.values()) == pytest.approx(1.0)


def test_mdp_value_iteration_converges_below_epsilon_and_is_fixed_point():
    m = _mdp(p_trap=0.4)
    T, _ = build_model(m)
    V, Q, hist, k = value_iteration(T, m.gamma, 1e-6)
    assert hist[-1]["delta"] < 1e-6 and k < 10_000
    for s in (0, 1):
        assert V[s] == pytest.approx(max(Q[s]), abs=1e-4)


def test_mdp_expected_utility_matches_monte_carlo():
    out = solve(_mdp(p_trap=0.5))
    for a in ACTIONS:
        assert out["monte_carlo"][a] == pytest.approx(out["expected_utility"][a], abs=0.04 * 1000)


def test_mdp_clean_mempool_executes_and_trap_overrides():
    assert solve(_mdp(p_trap=0.0))["recommended_action"] == "EXECUTE_FLASH_SWAP"
    assert solve(_mdp(p_trap=0.9, net_profit=2700.0))["recommended_action"] != "EXECUTE_FLASH_SWAP"


def test_mdp_negative_profit_never_executes():
    out = solve(_mdp(net_profit=-250.0, p_trap=0.0))
    assert out["recommended_action"] == "ABORT_AND_WAIT"


def test_mdp_policy_is_argmax_of_q():
    out = solve(_mdp(p_trap=0.3))
    for i, s in enumerate(out["Q"]):
        vals = list(out["Q"][s].values())
        assert out["policy_idx"][i] == vals.index(max(vals))


def test_mdp_discount_changes_value_of_waiting():
    lo = solve(_mdp(p_trap=0.8, gamma=0.1))["Q"]["s1_Volatile_Sandwich_Threat"]["ABORT_AND_WAIT"]
    hi = solve(_mdp(p_trap=0.8, gamma=0.99))["Q"]["s1_Volatile_Sandwich_Threat"]["ABORT_AND_WAIT"]
    assert hi > lo


def test_mdp_rejects_bad_inputs():
    with pytest.raises(ValueError):
        solve(_mdp(p_trap=1.5))
    with pytest.raises(ValueError):
        solve(_mdp(gamma=1.0))


# ------------------------------------------------------------------ pipeline --------
def test_pipeline_feeds_astar_profit_and_bayes_posterior_into_mdp():
    r = run_pipeline({"scenario": "beta"})
    assert r["mdp"]["params"]["net_profit"] == pytest.approx(r["astar"]["best"]["profit_usd"])
    assert r["mdp"]["params"]["p_trap"] == pytest.approx(r["bayes"]["p_trap"])
    assert r["mdp"]["recommended_action"] in ("PRIVATE_RPC_PROTECT", "ABORT_AND_WAIT")


def test_pipeline_alpha_executes():
    assert run_pipeline({"scenario": "alpha"})["mdp"]["recommended_action"] == "EXECUTE_FLASH_SWAP"


def test_rubric_cards_have_four_parts():
    r = run_pipeline({"scenario": "alpha"})
    for k in ("astar", "bayes", "mdp"):
        assert {"input", "steps", "output", "explanation"} <= r[k]["rubric"].keys()


def test_custom_override_changes_outcome():
    a = run_pipeline({"scenario": "delta", "capital": 10_000, "gas_gwei": 15, "dislocation": 1.5})
    b = run_pipeline({"scenario": "delta", "capital": 10_000, "gas_gwei": 15, "dislocation": 1.5,
                      "sensors": {"gas_priority_spike": True, "mev_bot_signature": True, "pool_imbalance_shock": True}})
    assert b["bayes"]["p_trap"] > a["bayes"]["p_trap"]


def test_http_api_roundtrip():
    from fastapi.testclient import TestClient
    from app import app
    c = TestClient(app)
    assert c.get("/").status_code == 200
    j = c.get("/api/run/alpha").json()
    assert j["mdp"]["recommended_action"] == "EXECUTE_FLASH_SWAP"
    j = c.post("/api/run", json={"scenario": "delta", "capital": 5000, "prior": 0.3}).json()
    assert j["params"]["capital"] == 5000
    assert c.get("/api/run/nope").status_code == 404

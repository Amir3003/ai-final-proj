"""Algorithm 2 — Exact multi-sensor Bayesian inference over the hidden mempool state.

H1 = Hostile mempool (MEV sandwich trap), H0 = Clean execution window.
Sensors are modelled as conditionally independent given the hidden state (naive-Bayes):
    P(E | H) = prod_i P(e_i | H)
and each sensor has a true-positive rate P(on|H1) and a false-positive rate P(on|H0).
"""
from __future__ import annotations

from typing import Dict, Optional

SENSORS: Dict[str, dict] = {
    "gas_priority_spike": {
        "label": "Gas_Priority_Spike", "detail_on": "+45 Gwei priority surge in target block",
        "detail_off": "priority fee flat vs. 10-block median", "p_on_h1": 0.70, "p_on_h0": 0.15},
    "mev_bot_signature": {
        "label": "Known_MEV_Bot_Signature", "detail_on": "pending high-value router call hits the same pool",
        "detail_off": "no known searcher bytecode in pending set", "p_on_h1": 0.88, "p_on_h0": 0.04},
    "pool_imbalance_shock": {
        "label": "Pool_Imbalance_Shock", "detail_on": "whale swap shifted reserves >1.5% last block",
        "detail_off": "reserve ratio within 0.2% of 10-block mean", "p_on_h1": 0.60, "p_on_h0": 0.12},
}


def _lik(sensor: dict, reading: bool, h1: bool) -> float:
    p = sensor["p_on_h1"] if h1 else sensor["p_on_h0"]
    return p if reading else 1.0 - p


def infer(prior_h1: float, readings: Dict[str, Optional[bool]], sensors: Dict[str, dict] | None = None) -> dict:
    """readings[name] -> True (sensor fired), False (sensor silent) or None/missing (not observed)."""
    sensors = sensors or SENSORS
    if not 0.0 <= prior_h1 <= 1.0:
        raise ValueError("prior must lie in [0,1]")
    for s in sensors.values():
        for k in ("p_on_h1", "p_on_h0"):
            if not 0.0 < s[k] < 1.0:
                raise ValueError("sensor rates must lie strictly in (0,1)")

    observed = [(n, bool(r)) for n, r in readings.items() if r is not None and n in sensors]
    # ---- sequential updates -------------------------------------------------------
    p = prior_h1
    sequential = []
    for name, r in observed:
        s = sensors[name]
        l1, l0 = _lik(s, r, True), _lik(s, r, False)
        marg = l1 * p + l0 * (1.0 - p)
        if marg <= 0:
            raise ValueError("zero-probability evidence")
        post = l1 * p / marg
        sequential.append({"sensor": s["label"], "key": name, "reading": "FIRED" if r else "SILENT",
                           "detail": s["detail_on"] if r else s["detail_off"],
                           "prior": p, "p_e_given_h1": l1, "p_e_given_h0": l0, "p_e": marg, "posterior": post,
                           "likelihood_ratio": l1 / l0 if l0 > 0 else float("inf")})
        p = post

    # ---- combined (batch) update ---------------------------------------------------
    L1 = L0 = 1.0
    for name, r in observed:
        L1 *= _lik(sensors[name], r, True)
        L0 *= _lik(sensors[name], r, False)
    p_e = L1 * prior_h1 + L0 * (1.0 - prior_h1)
    if p_e <= 0:
        raise ValueError("zero-probability evidence")
    posterior = L1 * prior_h1 / p_e

    pretty = ", ".join(f"{sensors[n]['label']}={'ON' if r else 'off'}" for n, r in observed) or "no sensors observed"
    verdict = ("HOSTILE" if posterior >= 0.5 else "CLEAN")
    expl = (f"Starting from a {prior_h1:.1%} prior of a sandwich trap, the evidence ({pretty}) is "
            f"{L1 / L0:.2f}× more likely under H1 than H0, so Bayes' rule moves the trap probability to {posterior:.1%} ({verdict}).")
    if L0 == 0:
        expl = "Evidence is impossible under H0, so the trap is certain."
    steps = [
        f"P(H1) = {prior_h1:.6f},  P(H0) = {1 - prior_h1:.6f}",
        f"P(E|H1) = {' × '.join(f'{_lik(sensors[n], r, True):.4f}' for n, r in observed) or '1'} = {L1:.6f}",
        f"P(E|H0) = {' × '.join(f'{_lik(sensors[n], r, False):.4f}' for n, r in observed) or '1'} = {L0:.6f}",
        f"P(E) = P(E|H1)P(H1) + P(E|H0)P(H0) = {L1:.6f}·{prior_h1:.4f} + {L0:.6f}·{1 - prior_h1:.4f} = {p_e:.6f}",
        f"P(H1|E) = P(E|H1)P(H1) / P(E) = {L1 * prior_h1:.6f} / {p_e:.6f} = {posterior:.6f}",
    ]
    out = {
        "algorithm": "Bayes", "prior_h1": prior_h1, "prior_h0": 1.0 - prior_h1,
        "readings": {n: readings.get(n) for n in sensors},
        "sensors": {n: {"label": s["label"], "p_on_h1": s["p_on_h1"], "p_on_h0": s["p_on_h0"],
                        "detail_on": s["detail_on"], "detail_off": s["detail_off"]} for n, s in sensors.items()},
        "sequential": sequential, "likelihood_h1": L1, "likelihood_h0": L0, "marginal": p_e,
        "posterior_h1": posterior, "posterior_h0": 1.0 - posterior, "p_trap": posterior,
        "verdict": verdict, "steps": steps, "explanation": expl,
        "sequential_matches_batch": abs(p - posterior) < 1e-12,
    }
    return out

"""Algorithm 3 — Markov Decision Process over the execution decision.

States   : s0 Safe_Optimal_Window, s1 Volatile_Sandwich_Threat, s2 Terminal_Executed, s3 Terminal_Aborted
           (the task's single "s2: Terminal" is split in two so that reward bookkeeping stays exact)
Actions  : a1 EXECUTE_FLASH_SWAP, a2 PRIVATE_RPC_PROTECT, a3 ABORT_AND_WAIT
Belief   : P(s0)=1-p_trap, P(s1)=p_trap   (p_trap comes from Algorithm 2)
Rewards  : parameterised by the A* net profit P (after gas), the capital C and the gas bill G.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, asdict
from typing import Dict, List, Tuple

STATES = ["s0_Safe_Optimal_Window", "s1_Volatile_Sandwich_Threat", "s2_Terminal_Executed", "s3_Terminal_Aborted"]
ACTIONS = ["EXECUTE_FLASH_SWAP", "PRIVATE_RPC_PROTECT", "ABORT_AND_WAIT"]
NON_TERMINAL = (0, 1)


@dataclass
class MDPParams:
    net_profit: float            # from A*
    gas_total: float             # from A*
    capital: float
    p_trap: float                # from Bayes
    gamma: float = 0.95          # discount factor
    epsilon: float = 1e-6
    loss_frac: float = 0.012     # capital fraction lost when a public tx is sandwiched
    p_sandwich_public: float = 0.90
    p_sandwich_private: float = 0.05
    p_inclusion_private: float = 0.92
    bribe_frac: float = 0.25
    bribe_min: float = 5.0
    p_gone: float = 0.35         # opportunity decays: someone else takes it while we wait
    persist: float = 0.60        # P(hostile next block | hostile now)
    onset: float = 0.10          # P(hostile next block | clean now)
    wait_cost_frac: float = 0.01
    wait_cost_min: float = 1.0

    def validate(self):
        if not 0.0 <= self.p_trap <= 1.0:
            raise ValueError("p_trap must lie in [0,1]")
        if not 0.0 <= self.gamma < 1.0:
            raise ValueError("discount factor must lie in [0,1)")


def build_model(m: MDPParams):
    """Return T[(s,a)] = {s': (prob, expected_reward)} (expected reward conditional on the transition)."""
    m.validate()
    loss = m.loss_frac * m.capital + m.gas_total
    bribe = max(m.bribe_min, m.bribe_frac * max(m.net_profit, 0.0))
    wait_cost = max(m.wait_cost_min, m.wait_cost_frac * max(m.net_profit, 0.0))
    s0, s1, sx, sa = 0, 1, 2, 3
    T: Dict[Tuple[int, int], Dict[int, Tuple[float, float]]] = {}

    # a1 EXECUTE: public mempool
    T[(s0, 0)] = {sx: (1.0, m.net_profit)}
    T[(s1, 0)] = {sx: (1.0, m.p_sandwich_public * (-loss) + (1 - m.p_sandwich_public) * m.net_profit)}
    # a2 PRIVATE RPC: bundle may fail to land (no cost), bribe paid only on inclusion
    i = m.p_inclusion_private
    T[(s0, 1)] = {sx: (i, m.net_profit - bribe), sa: (1 - i, 0.0)}
    r1 = m.p_sandwich_private * (-loss - bribe) + (1 - m.p_sandwich_private) * (m.net_profit - bribe)
    T[(s1, 1)] = {sx: (i, r1), sa: (1 - i, 0.0)}
    # a3 ABORT & WAIT: hold capital, mempool evolves as a 2-state Markov chain, opportunity may vanish
    g = m.p_gone
    T[(s0, 2)] = {s0: ((1 - g) * (1 - m.onset), -wait_cost), s1: ((1 - g) * m.onset, -wait_cost), sa: (g, -wait_cost)}
    T[(s1, 2)] = {s0: ((1 - g) * (1 - m.persist), -wait_cost), s1: ((1 - g) * m.persist, -wait_cost), sa: (g, -wait_cost)}
    for t in (sx, sa):                       # absorbing terminals
        for a in range(3):
            T[(t, a)] = {t: (1.0, 0.0)}
    for key, row in T.items():
        assert abs(sum(p for p, _ in row.values()) - 1.0) < 1e-9, key
    return T, {"loss_if_sandwiched": loss, "bribe": bribe, "wait_cost": wait_cost}


def one_step_eu(T, belief: List[float]) -> List[float]:
    eu = []
    for a in range(3):
        eu.append(sum(belief[s] * sum(p * r for p, r in T[(s, a)].values()) for s in NON_TERMINAL))
    return eu


def value_iteration(T, gamma: float, eps: float = 1e-6, max_iter: int = 100_000):
    V = [0.0] * 4
    hist = [{"k": 0, "V": V[:2], "delta": None}]
    k = 0
    while k < max_iter:
        k += 1
        Vn = V[:]
        for s in NON_TERMINAL:
            Vn[s] = max(sum(p * (r + gamma * V[s2]) for s2, (p, r) in T[(s, a)].items()) for a in range(3))
        delta = max(abs(Vn[s] - V[s]) for s in NON_TERMINAL)
        V = Vn
        hist.append({"k": k, "V": V[:2], "delta": delta})
        if delta < eps:
            break
    Q = [[sum(p * (r + gamma * V[s2]) for s2, (p, r) in T[(s, a)].items()) for a in range(3)] for s in NON_TERMINAL]
    return V, Q, hist, k


def monte_carlo(T, belief, n=4000, seed=7):
    """Sample the hidden state ~ belief, then the one-step outcome; mean must match EU(a)."""
    rng = random.Random(seed)
    out = []
    for a in range(3):
        tot = 0.0
        for _ in range(n):
            s = 1 if rng.random() < belief[1] else 0
            u, acc = rng.random(), 0.0
            for s2, (p, r) in T[(s, a)].items():
                acc += p
                if u <= acc:
                    tot += r
                    break
        out.append(tot / n)
    return out


def solve(m: MDPParams) -> dict:
    T, derived = build_model(m)
    belief = [1.0 - m.p_trap, m.p_trap]
    eu = one_step_eu(T, belief)
    V, Q, hist, iters = value_iteration(T, m.gamma, m.epsilon)
    policy = [int(max(range(3), key=lambda a: Q[s][a])) for s in NON_TERMINAL]
    belief_q = [sum(belief[s] * Q[s][a] for s in NON_TERMINAL) for a in range(3)]
    rec = int(max(range(3), key=lambda a: belief_q[a]))
    one_step_best = int(max(range(3), key=lambda a: eu[a]))
    mc = monte_carlo(T, belief)

    trans = []
    for s in NON_TERMINAL:
        for a in range(3):
            for s2, (p, r) in T[(s, a)].items():
                trans.append({"s": STATES[s], "a": ACTIONS[a], "s_next": STATES[s2], "T": p, "R": r})

    prof = m.net_profit
    pol_txt = {STATES[s]: ACTIONS[policy[s]] for s in NON_TERMINAL}
    expl = (f"With a {m.p_trap:.1%} trap belief and an A* net profit of ${prof:,.2f}, "
            f"{ACTIONS[rec]} has the highest long-run expected value (${belief_q[rec]:,.2f}); "
            f"{'EXECUTE wins because the hostile mass is too small to justify a bribe or a delay.' if rec == 0 else ''}"
            f"{'the private relay pays a bribe but removes most of the sandwich loss, beating a naked broadcast.' if rec == 1 else ''}"
            f"{'holding capital beats both broadcasting options because their expected loss/bribe exceeds the profit at stake.' if rec == 2 else ''}").strip()
    steps = [
        f"Belief b = [P(s0), P(s1)] = [{belief[0]:.4f}, {belief[1]:.4f}]  (p_trap from Bayes)",
        f"Rewards: profit P=${prof:,.2f}, sandwich loss L=${derived['loss_if_sandwiched']:,.2f}, bribe B=${derived['bribe']:,.2f}, wait cost c=${derived['wait_cost']:,.2f}",
        "One-step EU(a) = Σ_s b(s) Σ_s' T(s,a,s')R(s,a,s') → " + ", ".join(f"{ACTIONS[a]}=${eu[a]:,.2f}" for a in range(3)),
        f"Value iteration V_{{k+1}}(s)=max_a Σ T[R+γV_k(s')], γ={m.gamma}, converged after {iters} sweeps (Δ<{m.epsilon:g})",
        "Q* rows s0,s1: " + "; ".join(f"{STATES[s][:2]}=[" + ", ".join(f"{q:,.2f}" for q in Q[s]) + "]" for s in NON_TERMINAL),
        f"π*(s0)={ACTIONS[policy[0]]}, π*(s1)={ACTIONS[policy[1]]};  argmax_a Σ b(s)Q*(s,a) = {ACTIONS[rec]}",
    ]
    return {
        "algorithm": "MDP", "params": asdict(m), "derived": derived, "states": STATES, "actions": ACTIONS,
        "belief": belief, "transitions": trans, "expected_utility": dict(zip(ACTIONS, eu)),
        "monte_carlo": dict(zip(ACTIONS, mc)), "V": V[:2], "Q": {STATES[s]: dict(zip(ACTIONS, Q[s])) for s in NON_TERMINAL},
        "Q_matrix": Q, "policy": pol_txt, "policy_idx": policy, "belief_q": dict(zip(ACTIONS, belief_q)),
        "recommended_action": ACTIONS[rec], "recommended_idx": rec, "one_step_best": ACTIONS[one_step_best],
        "iterations": iters, "history": hist, "converged": hist[-1]["delta"] is not None and hist[-1]["delta"] < m.epsilon,
        "steps": steps, "explanation": expl,
    }

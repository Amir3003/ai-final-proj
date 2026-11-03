#!/usr/bin/env python3
"""QUASAR-ARB — FastAPI server (--serve) and terminal report (--cli)."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

from core.pipeline import SCENARIOS, run_pipeline

ROOT = Path(__file__).parent


def create_app():
    from fastapi import FastAPI
    from fastapi.responses import FileResponse, JSONResponse
    from fastapi.staticfiles import StaticFiles

    app = FastAPI(title="QUASAR-ARB Quantum Core Navigator")
    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")

    @app.get("/")
    def index():
        return FileResponse(ROOT / "templates" / "index.html")

    @app.get("/api/scenarios")
    def scenarios():
        return list(SCENARIOS.values())

    @app.get("/api/run/{scenario}")
    def run_get(scenario: str):
        if scenario not in SCENARIOS:
            return JSONResponse({"error": f"unknown scenario {scenario}"}, status_code=404)
        return run_pipeline({"scenario": scenario})

    @app.post("/api/run")
    def run_post(body: Optional[dict] = None):
        try:
            return run_pipeline(body or {})
        except (ValueError, KeyError) as e:
            return JSONResponse({"error": str(e)}, status_code=422)

    return app


app = create_app()


# ------------------------------------------------------------------------------ CLI
def _money(x): return f"${x:,.2f}"


def cli_report(keys, trace_rows=8):
    out = []
    w = out.append
    bar = "═" * 100
    for key in keys:
        r = run_pipeline({"scenario": key})
        P, a, b, y, m, ex = r["params"], r["astar"], r["bfs"], r["bayes"], r["mdp"], r["execution"]
        best = a.get("best") or a.get("fallback_best")
        w(bar); w(f" {r['scenario']['name'].upper()}"); w(f" {r['scenario']['blurb']}"); w(bar)
        w(f" INPUT  capital={_money(P['capital'])}  gas={P['gas_gwei']:g} gwei  prior P(H1)={P['prior']:.2%}  "
          f"γ={P['gamma']}  sensors={[k for k, v in P['sensors'].items() if v] or 'none fired'}")
        w("\n ┌─ ALGORITHM 1 · A* informed graph search (BFS baseline)")
        w(f" │ INPUT  : 8 tokens, {len(r['pools'])*2} directed edges, start=USDC, max 4 hops")
        w(" │ CALC   : w(u→v) = -ln r_eff;  f(n)=g(n)+h(n);  priority-queue expansions:")
        for t in a["trace"][:trace_rows]:
            if t["event"] == "EXPAND":
                top = t["open_set"][0] if t["open_set"] else None
                w(f" │   #{t['step']:>2} pop {t['path']:<28} g={t['g']:+.5f} h={t['h']:+.5f} f={t['f']:+.5f} | open={t['open_size']}"
                  + (f" next-best={top['path']} f={top['f']:+.5f}" if top else ""))
            elif t["event"] == "GOAL":
                w(f" │   #{t['step']:>2} GOAL {t['path']:<28} g={t['g']:+.5f} f={t['f']:+.5f}")
            else:
                w(f" │   ROOT pruned: idealised best cycle f={t['f']:+.5f} > 0 → no profitable cycle can exist")
        if best:
            for l in best["legs"]:
                w(f" │   hop {l['from']:>4}→{l['to']:<4} via {l['pool']} ({l['protocol']}) in={l['amount_in']:.4f} out={l['amount_out_net']:.4f} "
                  f"impact={l['price_impact_pct']:.3f}% gas={_money(l['gas_usd'])} w={l['weight']:+.5f}")
            w(f" │ OUTPUT : {' → '.join(best['route'])}  net profit {_money(best['profit_usd'])} ({best['profit_bps']:+.1f} bps), gas {_money(best['gas_total_usd'])}"
              + ("" if r["profitable"] else "  [NOT PROFITABLE]"))
        w(f" │ A* expanded {a['expanded']} / generated {a['generated']} / pruned {a['pruned']}   |   BFS expanded {b['expanded']} / generated {b['generated']}")
        w(f" └ WHY    : {a['explanation']}")

        w("\n ┌─ ALGORITHM 2 · Exact multi-sensor Bayesian inference")
        w(f" │ INPUT  : prior P(H1)={y['prior_h1']:.4f}; readings=" + ", ".join(f"{s['label']}={'ON' if y['readings'][k] else 'off'}" for k, s in y["sensors"].items()))
        for s in y["steps"]:
            w(f" │ CALC   : {s}")
        for s in y["sequential"]:
            w(f" │   seq  : {s['sensor']:<24}{s['reading']:<7} LR={s['likelihood_ratio']:.3f}  {s['prior']:.4f} → {s['posterior']:.4f}")
        w(f" │ OUTPUT : p_trap = P(H1|E) = {y['p_trap']:.4%}   ({y['verdict']})")
        w(f" └ WHY    : {y['explanation']}")

        w("\n ┌─ ALGORITHM 3 · MDP (expected utility + Bellman value iteration)")
        w(f" │ INPUT  : net profit {_money(m['params']['net_profit'])}, p_trap={m['params']['p_trap']:.4f}, γ={m['params']['gamma']}")
        for s in m["steps"]:
            w(f" │ CALC   : {s}")
        w(" │ Q(s,a) : " + " " * 22 + "  ".join(f"{a_[:12]:>14}" for a_ in m["actions"]))
        for s, row in m["Q"].items():
            w(f" │          {s[:26]:<26}" + "  ".join(f"{v:>14,.2f}" for v in row.values()))
        w(f" │ OUTPUT : π* = {m['policy']};  recommended = {m['recommended_action']}")
        w(f" └ WHY    : {m['explanation']}")
        w(f"\n ▶ STAGE 4 EXECUTION: {ex['status']} — {ex['verdict']}  (EV {_money(ex['expected_value_usd'])})\n")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--cli", action="store_true", help="print the formatted terminal report")
    ap.add_argument("--serve", action="store_true", help="start the web server")
    ap.add_argument("--scenario", choices=list(SCENARIOS), help="CLI: one scenario only (default: all four)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args(argv)
    if args.cli:
        print(cli_report([args.scenario] if args.scenario else list(SCENARIOS)))
        return 0
    if args.serve or not args.cli:
        import uvicorn
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())

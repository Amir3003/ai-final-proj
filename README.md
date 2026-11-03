# QUASAR-ARB · Quantum Core & Deep-Space DeFi Arbitrage Navigator
AI Fundamentals final project: **A\* → Bayes → MDP** pipeline for DEX cycle arbitrage, with a living-galaxy web UI.

## Run
```bash
pip install fastapi uvicorn pytest playwright httpx
python app.py --cli                  # terminal report, all 4 scenarios (add --scenario beta for one)
python app.py --serve --port 8000    # web UI at http://127.0.0.1:8000  (fonts + KaTeX are vendored, works offline)
pytest tests -v                      # 68 tests (66 algorithm/API + 2 JS-parity; parity needs node)
python tests/verify_ui.py            # Playwright run (starts its own server) -> screenshots/
```

## Static build (no Python server) — deploy on Vercel
```bash
python static-build/build_static.py   # regenerates dist/ (committed, ready to deploy)
```
`dist/` is a fully client-side copy: all 4 scenarios and the live Manual-Override sliders run on `static-build/engine.js`, a 1:1 JS port of `core/`
(reference data is exported from the Python modules, so Python stays the single source of truth; `tests/test_static_parity.py` deep-compares
both engines on the 4 presets + 25 random overrides). `app.py` and `core/` are untouched by it.
Vercel: import the repo, set **Root Directory = `dist`**, Framework = Other (no build command). Or: `cd dist && npx vercel --prod`.
Test it: `python tests/verify_ui.py --static`.

## Algorithms (all in `core/`)
**1. A\* + BFS (`graph_search.py`)** — 8 tokens, 14 pools = 28 directed edges, fees 0.05/0.30/1.00 %.
Constant-product swap `dy = y·κ·dx/(x+κ·dx)`, κ = 1 − fee (the task's "γ"; renamed to avoid clashing with the MDP discount).
Gas drag is deducted from each hop's output. Effective rate `r_eff = value_out_net / value_in`, weight `w = −ln r_eff`;
path weights telescope to `g = −ln(final/start)`, so `g < 0` ⇔ profit.
Heuristic `h(n,k) = −ln(best idealised spot-rate return to start within k hops)` — ignores impact and gas, which only
reduce returns, so it is **admissible** and A\* is optimal (tests compare with brute force). Unprofitable branches (`f > 0`) are pruned.
BFS enumerates all simple cycles ≤ 4 hops as the baseline.

**2. Bayes (`bayesian_mempool.py`)** — H1 hostile mempool vs H0 clean; three conditionally independent sensors with TPR/FPR.
`P(E|H)=Π P(e_i|H)`, `P(E)=P(E|H1)P(H1)+P(E|H0)P(H0)`, `P(H1|E)=P(E|H1)P(H1)/P(E)`. Sequential and batch updates are verified identical.

**3. MDP (`mdp_controller.py`)** — states s0 safe, s1 sandwich threat, terminal executed / aborted (the task's s2 is split in two).
Actions EXECUTE / PRIVATE_RPC (bribe, 92 % inclusion, 5 % residual sandwich) / ABORT_AND_WAIT (hostile-mempool Markov chain, 35 % chance the opportunity vanishes).
Rewards use the A\* net profit; belief uses the Bayes posterior. Reports one-step `EU(a)`, Bellman value iteration to ε < 1e-6, `Q*`, `π*`,
and a Monte-Carlo check of EU. Note: the recommended action maximises `Σ b(s)Q*(s,a)`, so WAIT can score high there (it enables later execution) while its one-step EU is negative.

## Scenarios (sample I/O)
| | route | net profit | p_trap | action |
|--|--|--|--|--|
| α Tranquil Nebula | USDC→WBTC→ETH→USDC | $535.28 | 0.11 % | EXECUTE |
| β MEV Supernova Trap | USDC→ETH→WBTC→USDC | $2,756.80 | 89.17 % | PRIVATE_RPC_PROTECT |
| γ Gas Storm (250 gwei) | USDC→WBTC→ETH→SOL→USDC (4 hops) | $1,101.15 | 2.86 % | EXECUTE |
| δ Manual override | sliders + sensor checkboxes on the loaded market | — | — | — |

Market mispricings are synthetic snapshots (`core/market_profiles.py`); prices and pool sizes are illustrative, not live data.

## Defense guide
Scroll = dive (z 1000→50); bottom slider = wavelength (IR = slippage heat, X-ray = MEV radiation); **▶ QUANTUM TRACE** replays the 4 stages with a live math log;
**☰ RUBRIC** shows Input → Steps → Output → One-sentence explanation for each algorithm; ⌕ INSPECT opens the same card inside each panel.
The galaxy auto-lowers its render scale and disables panel blur on slow/software renderers.

#!/usr/bin/env python3
"""Playwright verification of the QUASAR-ARB web UI + screenshot capture.

    python tests/verify_ui.py                      # starts its own server on a free port
    python tests/verify_ui.py --url http://127.0.0.1:8000

Exits non-zero if any assertion fails or if the page logs any console error / page error.
"""
from __future__ import annotations

import argparse
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((bool(cond), name, detail))
    print(("  PASS " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)
    return bool(cond)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


def num(text):
    m = re.search(r"-?[\d,]+(?:\.\d+)?", text.replace("−", "-"))
    return float(m.group(0).replace(",", "")) if m else float("nan")


def start_server(url, static=False):
    if static:
        port = free_port(); url = f"http://127.0.0.1:{port}"
        proc = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(ROOT / "dist")],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(40):
            try:
                urllib.request.urlopen(url + "/", timeout=1); return proc, url
            except Exception:
                time.sleep(0.25)
        raise RuntimeError("static server did not start")
    try:
        urllib.request.urlopen(url + "/", timeout=2); return None, url
    except Exception:
        pass
    port = free_port(); url = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen([sys.executable, str(ROOT / "app.py"), "--serve", "--port", str(port)], cwd=ROOT,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        try:
            urllib.request.urlopen(url + "/", timeout=1); return proc, url
        except Exception:
            time.sleep(0.25)
    raise RuntimeError("server did not start")


def launch(p):
    args = ["--no-sandbox", "--use-gl=swiftshader", "--ignore-gpu-blocklist"]
    try:
        return p.chromium.launch(args=args)
    except Exception:
        return p.chromium.launch(executable_path="/opt/pw-browsers/chromium", args=args)


def galaxy_pixels(page):
    return page.evaluate("""() => { const c=document.getElementById('galaxy'), t=document.createElement('canvas'); t.width=96; t.height=54;
        const x=t.getContext('2d'); x.drawImage(c,0,0,96,54); const d=x.getImageData(0,0,96,54).data; let r=0,g=0,b=0; const n=d.length/4;
        for(let i=0;i<d.length;i+=4){r+=d[i];g+=d[i+1];b+=d[i+2]} return {r:r/n,g:g/n,b:b/n}; }""")


def wait_idle(page):
    page.wait_for_function("document.body.dataset.busy==='0' && document.body.dataset.ready==='1'", timeout=20000)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--static", action="store_true", help="test the serverless dist/ build (no Python API)")
    ap.add_argument("--out", default=str(ROOT / "screenshots"))
    args = ap.parse_args()
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    proc, url = start_server(args.url, args.static)
    if args.static:
        print(f"[static build] serving dist/ at {url} — no /api endpoint exists there")
    errors = []
    try:
        with sync_playwright() as p:
            browser = launch(p)
            ctx = browser.new_context(viewport={"width": 1600, "height": 900}, device_scale_factor=2)
            page = ctx.new_page()
            page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error",) else None)
            page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
            page.on("requestfailed", lambda r: errors.append(f"requestfailed: {r.url}"))
            page.on("response", lambda r: errors.append(f"HTTP {r.status}: {r.url}") if r.status >= 400 else None)

            print("\n[1] galaxy canvas & boot")
            page.goto(url + "/"); wait_idle(page); page.wait_for_timeout(2500)
            dims = page.evaluate("(()=>{const c=document.getElementById('galaxy');return [c.width,c.height,c.clientWidth,c.clientHeight]})()")
            check("galaxy canvas has non-zero dimensions", all(v > 0 for v in dims), str(dims))
            n = page.evaluate("galaxy.particleCount")
            check("galaxy has 4,000+ particles", n >= 4000, str(n))
            px = galaxy_pixels(page)
            check("galaxy canvas actually painted (non-black)", px["r"] + px["g"] + px["b"] > 6, str({k: round(v, 1) for k, v in px.items()}))
            check("MathJax/KaTeX formula rendered", page.locator("#f-bayes .katex").count() > 0)
            check("constellation shows 8 tokens / 14 pools", page.evaluate("Object.keys(cons.data.tokens).length")==8 and page.evaluate("cons.data.pools.length")==14)
            page.screenshot(path=str(out / "01_galaxy_viewport.png"))

            print("\n[2] multi-wavelength slider")
            stats = {}
            for w, key in ((0, "visible"), (1, "infrared"), (2, "xray"), (3, "multi")):
                page.click(f'#spec-labels button[data-w="{w}"]')
                page.wait_for_timeout(2600)
                check(f"wavelength={key}: body state + active label", page.evaluate("document.body.dataset.wave") == key and
                      page.locator(f'#spec-labels button[data-w="{w}"].active').count() == 1)
                stats[key] = galaxy_pixels(page)
                if key == "xray":
                    page.screenshot(path=str(out / "02_wavelength_xray.png"))
                if key == "infrared":
                    page.screenshot(path=str(out / "02b_wavelength_infrared.png"))
                if key == "multi":
                    page.screenshot(path=str(out / "02c_wavelength_multi.png"))
            red = lambda s: s["r"] / (s["b"] + 1e-6)
            check("infrared is redder than visible", red(stats["infrared"]) > red(stats["visible"]) * 1.3, f"{red(stats['infrared']):.2f} vs {red(stats['visible']):.2f}")
            check("x-ray is bluer/violet vs infrared", red(stats["xray"]) < red(stats["infrared"]), f"{red(stats['xray']):.2f}")
            check("multi-wavelength is brighter than x-ray alone", sum(stats["multi"].values()) > sum(stats["xray"].values()))
            page.locator("#wave-slider").fill("1.5"); page.wait_for_timeout(900)
            check("continuous scrubbing works (slider=1.5 -> wave≈1.5)", abs(page.evaluate("galaxy.wave") - 1.5) < 0.3)
            page.click('#spec-labels button[data-w="0"]'); page.wait_for_timeout(800)

            print("\n[3] scroll-driven z-axis dive")
            zs = []
            for frac, layer in ((0.0, 1), (0.5, 2), (1.0, 3)):
                page.evaluate(f"window.scrollTo(0, {frac} * (document.documentElement.scrollHeight - innerHeight))")
                page.wait_for_timeout(3000)
                s = page.evaluate("galaxy.state"); zs.append(s["z"])
                check(f"scroll {int(frac*100)}% -> z={s['z']:.0f}, depth layer {s['layer']}", s["layer"] == layer)
                if layer == 2:
                    page.screenshot(path=str(out / "04_depth2_bayes.png"))
                if layer == 3:
                    page.screenshot(path=str(out / "05_depth3_mdp.png"))
            check("z falls monotonically 1000 -> 50", zs[0] > zs[1] > zs[2] and abs(zs[0] - 1000) < 5 and abs(zs[2] - 50) < 5, str([round(z) for z in zs]))
            check("depth layers revealed", page.locator(".layer.visible").count() == 3)
            page.evaluate("window.scrollTo(0,0)"); page.wait_for_timeout(1500)

            print("\n[4] scenarios -> live DOM telemetry")
            got = {}
            for sc in ("alpha", "beta", "gamma", "delta"):
                page.click(f'.scn[data-scenario="{sc}"]'); page.wait_for_timeout(300); wait_idle(page)
                page.wait_for_function(f"document.querySelector('.scn.active').dataset.scenario==='{sc}'")
                profit = num(page.inner_text("#tel-profit")); ptrap = num(page.inner_text("#tel-ptrap")) / 100
                action = page.inner_text("#tel-action"); route = page.inner_text("#tel-route"); hops = int(num(page.inner_text("#a-hops")))
                a_exp, b_exp = int(num(page.inner_text("#tel-astar-exp"))), int(num(page.inner_text("#tel-bfs-exp")))
                iters = int(num(page.inner_text("#tel-iter"))); marg = num(page.inner_text("#tel-marginal"))
                got[sc] = dict(profit=profit, ptrap=ptrap, action=action, route=route, hops=hops)
                check(f"{sc}: telemetry numeric ({route}, ${profit:,.2f}, p_trap={ptrap:.2%}, {action})",
                      profit == profit and 0 <= ptrap <= 1 and 0 < marg <= 1 and iters >= 1 and a_exp >= 1 and b_exp >= a_exp)
                check(f"{sc}: Q-matrix 2x3 + EU bars + VI table rendered", page.locator("#qmat tbody td[data-q]").count() == 6 and
                      page.locator("#eu-bars .eu-row").count() == 3 and page.locator("#vi-table tbody tr").count() >= 2)
                check(f"{sc}: exactly one policy star per state", page.locator("#qmat td.star").count() == 2)
            check("alpha: low risk -> EXECUTE", got["alpha"]["ptrap"] < 0.05 and got["alpha"]["action"] == "EXECUTE" and got["alpha"]["profit"] > 0)
            check("beta: posterior > 82% and MDP overrides greed", got["beta"]["ptrap"] > 0.82 and got["beta"]["action"] in ("PRIVATE RPC", "ABORT & WAIT") and got["beta"]["profit"] > 1000)
            check("gamma: gas storm -> deeper 4-hop wormhole", got["gamma"]["hops"] == 4 and got["gamma"]["profit"] > 0, got["gamma"]["route"])

            print("\n[5] Delta control deck")
            page.click('.scn[data-scenario="alpha"]'); wait_idle(page)
            base_p = num(page.inner_text("#tel-ptrap"))
            page.locator("#in-capital").fill("10000"); page.wait_for_timeout(800); wait_idle(page)
            check("deck edit switches to Delta", page.locator('.scn[data-scenario="delta"].active').count() == 1)
            check("capital slider re-sizes the trade", abs(page.evaluate("QA.res.params.capital") - 10000) < 1)
            for k in ("gas_priority_spike", "mev_bot_signature", "pool_imbalance_shock"):
                page.check(f"#sn-{k}"); page.wait_for_timeout(350)
            wait_idle(page); page.wait_for_timeout(500)
            hi_p = num(page.inner_text("#tel-ptrap"))
            check("ticking all 3 sensors raises posterior", hi_p > base_p + 30, f"{base_p}% -> {hi_p}%")
            page.locator("#in-gas").fill("400"); page.locator("#in-disl").fill("0"); page.wait_for_timeout(900); wait_idle(page)
            check("no-dislocation market -> 'no profitable cycle' + ABORT", page.inner_text("#tel-action") == "ABORT & WAIT" and page.locator(".route-line .loss").count() == 1)
            page.click('.scn[data-scenario="beta"]'); wait_idle(page)

            print("\n[6] Quantum Trace (4 stages)")
            page.evaluate("window.scrollTo(0,0)"); page.wait_for_timeout(600)
            page.click("#btn-trace")
            page.wait_for_function("document.body.dataset.stage==='1'", timeout=15000); page.wait_for_timeout(2500)
            page.screenshot(path=str(out / "03a_trace_stage1_astar.png"))
            page.wait_for_function("document.body.dataset.stage==='2'", timeout=60000); page.wait_for_timeout(2500)
            page.screenshot(path=str(out / "03b_trace_stage2_bayes.png"))
            page.wait_for_function("document.body.dataset.stage==='3'", timeout=60000); page.wait_for_timeout(1800)
            page.screenshot(path=str(out / "03c_trace_stage3_mdp.png"))
            page.wait_for_function("document.body.dataset.trace==='done'", timeout=90000); page.wait_for_timeout(1200)
            log = page.inner_text("#mathlog")
            check("trace finished; all 4 stages logged", all(f"STAGE {i}" in log for i in (1, 2, 3, 4)))
            check("math log contains Bayes/Bellman lines", "P(H1|E)" in log and "VI k=" in log and "A* GOAL" in log)
            check("stage chips marked done", page.locator(".stage.done").count() == 4)
            page.screenshot(path=str(out / "03_algorithm_trace.png"))

            print("\n[7] rubric inspector + tooltips + inspect drawers")
            page.evaluate("window.scrollTo(0,0)"); page.wait_for_timeout(1500)
            page.click("#btn-rubric"); page.wait_for_timeout(700)
            cards = page.locator("#rubric-body .rcard")
            txt = page.inner_text("#rubric-body")
            check("rubric drawer: 3 algorithm cards", cards.count() == 3)
            check("rubric: Input / Steps / Output / Explanation present x3", all(txt.count(k) == 3 for k in ("INPUT", "KEY CALCULATION STEPS", "OUTPUT", "ONE-SENTENCE EXPLANATION")))
            page.screenshot(path=str(out / "06_rubric_inspector.png"))
            page.click("#rubric-close"); page.wait_for_timeout(600)
            box = page.locator("#constellation").bounding_box()
            nx, ny = page.evaluate("[cons.nodes.ETH.x, cons.nodes.ETH.y]")
            page.mouse.move(box["x"] + nx, box["y"] + ny); page.wait_for_timeout(500)
            check("hovering a star shows tooltip", page.evaluate("getComputedStyle(document.getElementById('ctip')).opacity") == "1" and "ETH" in page.inner_text("#ctip"))
            page.click('[data-inspect="astar"]'); page.wait_for_timeout(300)
            check("inspection drawer opens inside the A* panel", page.locator("#inspect-astar.open .rcard").count() == 1)

            print("\n[8] mobile layout")
            m = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True)
            mp = m.new_page(); mp.on("pageerror", lambda e: errors.append(f"mobile pageerror: {e}"))
            mp.goto(url + "/"); mp.wait_for_function("document.body.dataset.ready==='1'"); mp.wait_for_timeout(2000)
            ow = mp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            check("no horizontal page scroll at 390px", ow <= 1, f"overflow={ow}")
            mp.screenshot(path=str(out / "07_mobile.png")); m.close()

            fps = page.evaluate("galaxy.fps")
            print(f"\n    (headless software-render fps={fps:.0f}, render-scale={page.evaluate('galaxy.quality'):.2f})")
            browser.close()
    finally:
        if proc:
            proc.terminate()
    print("\n[9] console / page errors")
    check("zero console errors, page errors or failed requests", not errors, "; ".join(errors[:5]))
    failed = [r for r in RESULTS if not r[0]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed" + ("" if not failed else "  FAILED: " + ", ".join(f[1] for f in failed)))
    print("screenshots ->", out)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

"""The JS engine used by the static build must reproduce the Python engine (all 4 scenarios + random Delta overrides)."""
import json
import math
import os
import random
import shutil
import subprocess
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from core.pipeline import run_pipeline  # noqa: E402

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")

SKIP = {"elapsed_ms", "monte_carlo", "explanation", "steps", "detail", "rubric", "definition"}   # free-text / RNG-dependent


def js_runs(reqs):
    dist = os.path.join(ROOT, "dist")
    if not os.path.exists(os.path.join(dist, "static/js/data.js")):
        subprocess.run([sys.executable, os.path.join(ROOT, "static-build/build_static.py")], check=True, stdout=subprocess.DEVNULL)
    script = ("global.window=undefined;const fs=require('fs');const vm=require('vm');"
              f"const ctx=globalThis;vm.runInThisContext(fs.readFileSync('{dist}/static/js/data.js','utf8').replace('window.QUASAR_DATA','globalThis.QUASAR_DATA'));"
              f"const E=require('{ROOT}/static-build/engine.js');"
              "const reqs=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(reqs.map(r=>E.runPipeline(r)),(k,v)=>v===Infinity?'__inf__':v));")
    out = subprocess.run(["node", "-e", script], input=json.dumps(reqs), capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def compare(a, b, path=""):
    if isinstance(a, dict):
        assert isinstance(b, dict) and set(a) - SKIP == set(b) - SKIP, f"keys differ at {path}: {set(a) ^ set(b)}"
        for k in a:
            if k not in SKIP:
                compare(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list):
        assert isinstance(b, list) and len(a) == len(b), f"len differs at {path}: {len(a)} vs {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f"{path}[{i}]")
    elif isinstance(a, float) or isinstance(b, float):
        if b == "__inf__":
            b = math.inf
        assert a == pytest.approx(b, rel=1e-9, abs=1e-9), f"{path}: {a} vs {b}"
    else:
        assert a == b, f"{path}: {a!r} vs {b!r}"


def test_four_presets_match_python():
    reqs = [{"scenario": s} for s in ("alpha", "beta", "gamma", "delta")]
    for req, js in zip(reqs, js_runs(reqs)):
        compare(run_pipeline(req), js, req["scenario"])


def test_random_delta_overrides_match_python():
    rnd = random.Random(11)
    reqs = []
    for _ in range(25):
        reqs.append({"scenario": "delta", "market": rnd.choice(["alpha", "beta", "gamma"]), "capital": rnd.randrange(1000, 250000, 1000),
                     "prior": round(rnd.random() * 0.95, 2), "gas_gwei": rnd.randrange(1, 400), "gamma": round(rnd.random() * 0.99, 2),
                     "dislocation": round(rnd.random() * 3, 1),
                     "sensors": {k: rnd.random() < 0.5 for k in ("gas_priority_spike", "mev_bot_signature", "pool_imbalance_shock")}})
    for req, js in zip(reqs, js_runs(reqs)):
        compare(run_pipeline(req), js, str(req))

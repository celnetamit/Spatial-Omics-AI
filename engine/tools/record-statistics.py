#!/usr/bin/env python3
"""
Records the SciPy reference values that engine/tests/statistics.test.ts checks
this engine against.

This is the same arrangement LogicLab uses for its Verilog simulator: a second,
independent implementation produces the expected answers, and the engine is
asserted to reproduce them. Self-consistency proves nothing about a p-value.

    pip install numpy scipy scikit-learn
    python3 engine/tools/record-statistics.py

**Read the diff before accepting a re-recording.** If a number moved, either the
engine changed or SciPy did, and which one it was is the only thing worth
knowing here.
"""
import json
import pathlib
import numpy as np
from scipy import stats

OUT = pathlib.Path(__file__).resolve().parents[1] / "tests" / "reference" / "statistics.json"

rng = np.random.default_rng(20260922)
out = {"generator": f"scipy {stats.__name__ and __import__('scipy').__version__} / numpy {np.__version__}", "cases": []}

for i, (na, nb) in enumerate([(12, 9), (30, 30), (5, 40), (200, 180), (3, 3), (60, 7)]):
    a = rng.normal(loc=2.0 + 0.3 * i, scale=1.0 + 0.4 * i, size=na)
    b = rng.normal(loc=2.0, scale=1.0, size=nb)
    t, p = stats.ttest_ind(a, b, equal_var=False)
    va, vb = a.var(ddof=1), b.var(ddof=1)
    sa, sb = va / na, vb / nb
    df = (sa + sb) ** 2 / (sa ** 2 / (na - 1) + sb ** 2 / (nb - 1))
    out["cases"].append({"kind": "welch",
                         "a": [round(float(x), 12) for x in a],
                         "b": [round(float(x), 12) for x in b],
                         "statistic": float(t), "pValue": float(p), "df": float(df)})

for na, nb in [(20, 25), (10, 10), (50, 8)]:
    a = np.round(rng.normal(3, 1.5, na), 0)
    b = np.round(rng.normal(2.5, 1.5, nb), 0)
    u, p = stats.mannwhitneyu(a, b, alternative="two-sided", use_continuity=True, method="asymptotic")
    out["cases"].append({"kind": "mannwhitney", "a": [float(x) for x in a], "b": [float(x) for x in b],
                         "statistic": float(u), "pValue": float(p)})


def bh(p):
    p = np.asarray(p, float)
    m = len(p)
    order = np.argsort(p)
    ranked = p[order] * m / (np.arange(m) + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    q = np.empty(m)
    q[order] = np.minimum(ranked, 1.0)
    return q


for _ in range(3):
    p = np.concatenate([rng.uniform(0, 0.02, 15), rng.uniform(0, 1, 85)])
    out["cases"].append({"kind": "bh", "p": [float(x) for x in p], "q": [float(x) for x in bh(p)]})

for _ in range(3):
    x = np.round(rng.normal(0, 1, 40), 1)
    y = 0.6 * x + rng.normal(0, 0.8, 40)
    out["cases"].append({"kind": "correlation", "x": [float(v) for v in x], "y": [float(v) for v in y],
                         "pearson": float(stats.pearsonr(x, y)[0]),
                         "spearman": float(stats.spearmanr(x, y)[0]),
                         "kendall": float(stats.kendalltau(x, y, variant="b")[0])})

out["cases"].append({"kind": "incompleteBeta", "points": [
    {"x": x, "a": a, "b": b, "value": float(stats.beta.cdf(x, a, b))}
    for (x, a, b) in [(0.3, 2, 3), (0.7, 0.5, 0.5), (0.01, 5, 1), (0.99, 1, 5),
                      (0.5, 20, 20), (0.2, 100, 3), (0.95, 3, 100)]]})

out["cases"].append({"kind": "normalCdf", "points": [
    {"z": float(z), "value": float(stats.norm.cdf(z))}
    for z in [-9, -4, -2.5, -1, -0.1, 0, 0.1, 1, 2.5, 4, 6]]})

try:
    from sklearn.metrics import roc_auc_score, average_precision_score
    for _ in range(2):
        labels = (rng.uniform(size=60) > 0.6).astype(int)
        scores = labels * 0.8 + rng.normal(0, 1, 60)
        out["cases"].append({"kind": "ranking", "labels": [int(v) for v in labels],
                             "scores": [float(v) for v in scores],
                             "auroc": float(roc_auc_score(labels, scores)),
                             "ap": float(average_precision_score(labels, scores))})
except ImportError:
    print("scikit-learn absent: ranking-metric cases not recorded")

OUT.write_text(json.dumps(out))
print(f"wrote {len(out['cases'])} case(s) to {OUT}")

/**
 * The statistics, checked against SciPy rather than against themselves.
 *
 * A p-value computed by a bespoke continued fraction agrees with itself
 * perfectly whether or not it is right, and a differential-expression table
 * with subtly wrong p-values is worse than none: it is read, thresholded and
 * acted on. So `reference/statistics.json` holds values produced by
 * scipy 1.13.1 / numpy 1.26.4, and these tests assert that this engine
 * reproduces them.
 *
 * Regenerate with `engine/tools/record-statistics.py` and **read the diff**
 * before accepting it. That is the whole value of the fixture.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  auroc, averagePrecision, benjaminiHochberg, incompleteBeta, kendallTau, mannWhitneyU,
  normalCdf, pearson, spearman, welchTTest,
} from '../src/core/stats';

interface Fixture {
  generator: string;
  cases: Record<string, unknown>[];
}

const fixture = JSON.parse(
  readFileSync(new URL('./reference/statistics.json', import.meta.url), 'utf8'),
) as Fixture;

function casesOf(kind: string): Record<string, unknown>[] {
  return fixture.cases.filter((c) => c.kind === kind);
}

describe('Welch t-test', () => {
  const cases = casesOf('welch');

  it('has reference cases to check against', () => {
    expect(cases.length).toBeGreaterThan(4);
  });

  for (const [index, reference] of cases.entries()) {
    it(`matches SciPy on case ${index} (n = ${(reference.a as number[]).length} vs ${(reference.b as number[]).length})`, () => {
      const result = welchTTest(reference.a as number[], reference.b as number[]);
      expect(result.statistic).toBeCloseTo(reference.statistic as number, 10);
      expect(result.df).toBeCloseTo(reference.df as number, 8);
      // Relative tolerance on p, because these span eleven orders of magnitude
      // and an absolute tolerance would pass everything below 1e-9 for free.
      const expected = reference.pValue as number;
      expect(Math.abs(result.pValue - expected) / Math.max(expected, 1e-300)).toBeLessThan(1e-9);
    });
  }
});

describe('Mann–Whitney U', () => {
  for (const [index, reference] of casesOf('mannwhitney').entries()) {
    it(`matches SciPy on tied case ${index}`, () => {
      const result = mannWhitneyU(reference.a as number[], reference.b as number[]);
      expect(result.statistic).toBeCloseTo(reference.statistic as number, 10);
      // The tie correction is the thing being checked here: without it the
      // p-values drift by several percent on rounded data.
      expect(result.pValue).toBeCloseTo(reference.pValue as number, 8);
    });
  }
});

describe('Benjamini–Hochberg', () => {
  for (const [index, reference] of casesOf('bh').entries()) {
    it(`reproduces the adjusted p-values on case ${index}`, () => {
      const adjusted = benjaminiHochberg(reference.p as number[]);
      const expected = reference.q as number[];
      for (let i = 0; i < expected.length; i += 1) {
        expect(adjusted[i] as number).toBeCloseTo(expected[i] as number, 12);
      }
    });
  }

  it('is monotone in the input, which is the property the enforcement buys', () => {
    const p = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
    const q = Array.from(benjaminiHochberg(p));
    for (let i = 1; i < q.length; i += 1) {
      expect(q[i] as number).toBeGreaterThanOrEqual(q[i - 1] as number);
    }
  });

  it('leaves an untestable feature as NaN rather than calling it q = 1', () => {
    const q = benjaminiHochberg([0.01, Number.NaN, 0.5]);
    expect(Number.isNaN(q[1] as number)).toBe(true);
    // And the NaN is not counted in m, so the two real tests adjust by 2.
    expect(q[0] as number).toBeCloseTo(0.02, 12);
  });
});

describe('correlation', () => {
  for (const [index, reference] of casesOf('correlation').entries()) {
    it(`matches SciPy on case ${index}, ties included`, () => {
      expect(pearson(reference.x as number[], reference.y as number[])).toBeCloseTo(reference.pearson as number, 12);
      expect(spearman(reference.x as number[], reference.y as number[])).toBeCloseTo(reference.spearman as number, 12);
      expect(kendallTau(reference.x as number[], reference.y as number[])).toBeCloseTo(reference.kendall as number, 12);
    });
  }
});

describe('special functions', () => {
  it('reproduces the regularised incomplete beta', () => {
    const points = (casesOf('incompleteBeta')[0] as { points: { x: number; a: number; b: number; value: number }[] }).points;
    for (const point of points) {
      expect(incompleteBeta(point.x, point.a, point.b)).toBeCloseTo(point.value, 13);
    }
  });

  it('reproduces the normal CDF, including the far tail', () => {
    const points = (casesOf('normalCdf')[0] as { points: { z: number; value: number }[] }).points;
    for (const point of points) {
      // Relative, not absolute: at z = -4 the value is 3e-5 and at z = 6 the
      // complement is 1e-9, so an absolute tolerance would pass the tail for
      // free — which is exactly where the rational approximation this replaced
      // was wrong.
      const expected = point.value;
      expect(Math.abs(normalCdf(point.z) - expected) / Math.max(expected, 1e-300)).toBeLessThan(1e-12);
    }
  });

  it('does not lose the far tail to cancellation', () => {
    // 1 - erf(z/sqrt2) evaluates to exactly 0 here; erfc does not.
    expect(normalCdf(-9)).toBeGreaterThan(0);
    expect(normalCdf(-9)).toBeLessThan(1.2e-19);
  });
});

describe('ranking metrics', () => {
  for (const [index, reference] of casesOf('ranking').entries()) {
    it(`matches scikit-learn on case ${index}`, () => {
      expect(auroc(reference.scores as number[], reference.labels as number[])).toBeCloseTo(reference.auroc as number, 10);
      expect(averagePrecision(reference.scores as number[], reference.labels as number[])).toBeCloseTo(reference.ap as number, 10);
    });
  }

  it('returns NaN rather than 0.5 when a class is absent', () => {
    expect(Number.isNaN(auroc([1, 2, 3], [0, 0, 0]))).toBe(true);
  });
});

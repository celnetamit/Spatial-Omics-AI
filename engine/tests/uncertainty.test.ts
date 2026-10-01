/**
 * The out-of-domain check.
 *
 * Its job is to say when a run is unlike anything the model was fitted on, so
 * the lab can withhold an interpretation rather than produce a confident number
 * outside the evidence. That makes a *wrong* domain distance worse than none:
 * it either hides a real mismatch or raises a false one, and both look the same
 * from the outside.
 */

import { describe, expect, it } from 'vitest';
import { assessDomain, buildDomainReference } from '../src/uncertainty/index';

const NAMES = ['observations', 'spacing', 'degree'];

function vectors(rows: number[][]): Float64Array[] {
  return rows.map((row) => Float64Array.from(row));
}

describe('a feature the training corpus held constant', () => {
  /*
   * The case that forced this.
   *
   * Every section in the training corpus had exactly 500 cells, so the
   * `observations` feature had zero variance. With `sd || 1` it was given a
   * standard deviation of one, and the bundled 2,400-cell demonstration case
   * scored z = 1900 — a domain distance of 1900.01 against a 99th-percentile
   * threshold of 3.92. Every real run was "out of domain", always, and the
   * reported reason was arithmetic rather than anything about the tissue.
   */
  const reference = buildDomainReference(NAMES, vectors([
    [500, 40, 6.0],
    [500, 44, 6.4],
    [500, 48, 6.8],
    [500, 52, 7.2],
  ]));

  it('is named as excluded rather than silently kept', () => {
    expect(reference.excludedFeatures).toEqual(['observations']);
    expect(reference.standardDeviations[0]).toBe(0);
  });

  it('does not contribute to the distance however far away the run is', () => {
    const near = assessDomain(Float64Array.from([500, 46, 6.6]), reference);
    const far = assessDomain(Float64Array.from([2400, 46, 6.6]), reference);
    expect(far.distance).toBeCloseTo(near.distance, 12);
  });

  it('does not by itself push a typical run out of domain', () => {
    // The whole failure: a run that matches the training distribution on every
    // feature that varies must read as in-domain.
    const assessment = assessDomain(Float64Array.from([2400, 46, 6.6]), reference);
    expect(assessment.status).toBe('in-domain');
    expect(assessment.distance).toBeLessThan(reference.distanceP95);
  });

  it('is flagged in the contributor list, so z = 0 is not read as agreement', () => {
    const assessment = assessDomain(Float64Array.from([2400, 46, 6.6]), reference);
    const observations = assessment.contributors.find((c) => c.name === 'observations');
    expect(observations?.excluded).toBe(true);
    expect(observations?.z).toBe(0);
    expect(observations?.value).toBe(2400);
  });
});

describe('a feature that does vary', () => {
  const reference = buildDomainReference(NAMES, vectors([
    [400, 40, 6.0],
    [500, 44, 6.4],
    [600, 48, 6.8],
    [700, 52, 7.2],
  ]));

  it('still catches a run that is genuinely far out', () => {
    const assessment = assessDomain(Float64Array.from([550, 12, 6.6]), reference);
    expect(assessment.status).toBe('out-of-domain');
    expect(assessment.contributors[0]?.name).toBe('spacing');
    expect(assessment.contributors[0]?.excluded).toBe(false);
  });

  it('reports a run inside the training range as in-domain', () => {
    expect(assessDomain(Float64Array.from([550, 46, 6.6]), reference).status).toBe('in-domain');
  });

  it('excludes nothing and says nothing about exclusions', () => {
    expect(reference.excludedFeatures).toEqual([]);
    expect(assessDomain(Float64Array.from([550, 46, 6.6]), reference).excludedNote).toBeUndefined();
  });
});

describe('the reference\'s own percentiles', () => {
  it('are computed with the same distance a later assessment uses', () => {
    // If the two drifted apart, every threshold in the pack would be measured
    // against a different quantity from the one compared to it.
    const rows = [
      [400, 40, 6.0], [500, 44, 6.4], [600, 48, 6.8],
      [700, 52, 7.2], [450, 42, 6.2], [650, 50, 7.0],
    ];
    const reference = buildDomainReference(NAMES, vectors(rows));
    const distances = rows.map((row) => assessDomain(Float64Array.from(row), reference).distance);
    // Every training point must sit at or below the 99th percentile the
    // reference reports for itself, allowing for the quantile's own step.
    const maximum = Math.max(...distances);
    expect(reference.distanceP99).toBeGreaterThan(0);
    expect(reference.distanceP99).toBeLessThanOrEqual(maximum + 1e-9);
    expect(reference.distanceP95).toBeLessThanOrEqual(reference.distanceP99 + 1e-9);
  });
});

describe('a pack written before the exclusion existed', () => {
  /*
   * Packs are frozen artefacts and outlive the code that wrote them. The field
   * is optional for that reason, and reading a pack without it must not throw —
   * `content:validate` is what refuses to ship one, at build time, where the
   * message can say to rebuild.
   */
  it('is read without throwing and without claiming an exclusion', () => {
    const modern = buildDomainReference(NAMES, vectors([
      [400, 40, 6.0], [500, 44, 6.4], [600, 48, 6.8], [700, 52, 7.2],
    ]));
    const legacy = { ...modern };
    delete (legacy as { excludedFeatures?: string[] }).excludedFeatures;

    const assessment = assessDomain(Float64Array.from([550, 46, 6.6]), legacy);
    expect(assessment.status).toBe('in-domain');
    expect(assessment.excludedNote).toBeUndefined();
    expect(assessment.contributors.every((c) => c.excluded === false)).toBe(true);
  });
});

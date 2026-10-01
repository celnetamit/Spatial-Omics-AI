/**
 * The mechanistic solver.
 *
 * These are the properties the whole lab rests on, and each of them failed at
 * least once during development in a way that looked like a working system:
 *
 *  - an unperturbed tissue is a fixed point (it was not, and the baseline
 *    drifted on every step);
 *  - an exogenous drive persists through relaxation (it did not, and the
 *    hypoxic core vanished before a single ligand had diffused);
 *  - a perturbation propagates, and the effect decays with distance (it did
 *    not, and the "spatial" model had nothing spatial to learn);
 *  - a receptor knockout propagates far less than a ligand knockout, which is
 *    the distinction that makes the mechanism worth having at all.
 */

import { describe, expect, it } from 'vitest';
import { compileNetwork } from '../src/propagate/network';
import {
  buildDiffusion, cloneState, computeField, emptyState, fullCapacity, meanField,
  noExogenousDrive, solveTissue, stateDelta, type TissueContext,
} from '../src/propagate/mechanism';
import type { ObservationRecord } from '../src/data/types';

const network = compileNetwork();
const K = network.nodes.length;

function lattice(n: number, pitch = 30): ObservationRecord[] {
  const side = Math.ceil(Math.sqrt(n));
  const out: ObservationRecord[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ id: `c${i}`, x: (i % side) * pitch, y: Math.floor(i / side) * pitch, sampleId: 's' });
  }
  return out;
}

function context(observations: ObservationRecord[], reference?: Float64Array): TissueContext {
  const n = observations.length;
  return {
    capacity: fullCapacity(n, K),
    exogenous: noExogenousDrive(n, K),
    diffusion: buildDiffusion(observations, network),
    // `null`, not a zero-filled array: zero is not a low reference, it is a
    // division by the floor. See `resolveReference`.
    ligandReference: reference ?? null,
  };
}

function basalState(n: number): ReturnType<typeof emptyState> {
  const state = emptyState(n, K);
  for (let i = 0; i < n; i += 1) {
    for (let node = 0; node < K; node += 1) state.activity[i * K + node] = network.basal[node] as number;
  }
  return state;
}

const OPTIONS = { innerSteps: 30, stages: 6, dt: 0.1, tolerance: 1e-6, ligandGain: 1.6, fieldCutoffFactor: 3 };

describe('the unperturbed tissue', () => {
  it('is a fixed point at basal with full capacity', () => {
    const observations = lattice(196);
    const start = basalState(observations.length);
    const ctx = context(observations);
    const solved = solveTissue(cloneState(start), network, ctx, null, OPTIONS);

    expect(solved.converged).toBe(true);
    const final = solved.stages[solved.stages.length - 1];
    let largest = 0;
    for (let i = 0; i < start.activity.length; i += 1) {
      largest = Math.max(largest, Math.abs((final?.activity[i] as number) - (start.activity[i] as number)));
    }
    // If this drifts, every downstream delta is measuring the solver settling
    // rather than the perturbation.
    expect(largest).toBeLessThan(1e-6);
  });

  it('is deterministic', () => {
    const observations = lattice(100);
    const ctx = context(observations);
    const a = solveTissue(basalState(observations.length), network, ctx, null, OPTIONS);
    const b = solveTissue(basalState(observations.length), network, ctx, null, OPTIONS);
    const lastA = a.stages[a.stages.length - 1];
    const lastB = b.stages[b.stages.length - 1];
    for (let i = 0; i < (lastA?.activity.length ?? 0); i += 1) {
      expect(lastB?.activity[i]).toBe(lastA?.activity[i]);
    }
  });
});

describe('an exogenous drive', () => {
  it('survives relaxation rather than being pulled back to basal', () => {
    const observations = lattice(144);
    const n = observations.length;
    const hif = network.index.get('HIF1A') as number;

    const ctx = context(observations);
    // A gradient across the lattice, as vessel distance would produce.
    for (let i = 0; i < n; i += 1) {
      ctx.exogenous.values[i * K + hif] = 3.4 * (i / (n - 1));
    }

    const solved = solveTissue(basalState(n), network, ctx, null, OPTIONS);
    const final = solved.stages[solved.stages.length - 1];
    const low = final?.activity[0 * K + hif] as number;
    const high = final?.activity[(n - 1) * K + hif] as number;

    // The first version wrote this as an initial condition and the relaxation
    // erased it: low and high came out identical.
    expect(high).toBeGreaterThan(low + 0.25);

    // And it reaches its own targets: CA9 is HIF1A-driven.
    const ca9 = network.index.get('CA9') as number;
    expect(final?.activity[(n - 1) * K + ca9] as number).toBeGreaterThan(final?.activity[0 * K + ca9] as number);
  });
});

describe('propagation', () => {
  function perturb(symbol: string, targets: number[], observations: ObservationRecord[]) {
    const n = observations.length;
    const baseline = solveTissue(basalState(n), network, context(observations), null, OPTIONS);
    const baseState = baseline.stages[baseline.stages.length - 1] as ReturnType<typeof emptyState>;
    const reference = meanField(computeField(baseState, network, buildDiffusion(observations, network)));

    const ctx = context(observations, reference);
    const clamp = new Float64Array(n * K).fill(Number.NaN);
    const node = network.index.get(symbol) as number;
    for (const i of targets) clamp[i * K + node] = 0;

    const solved = solveTissue(cloneState(baseState), network, ctx, clamp, {
      ...OPTIONS,
      ligandReference: reference,
      tolerance: 0,
      stages: 6,
    });
    return { baseState, solved };
  }

  it('reaches cells that were not perturbed, and decays with distance', () => {
    const observations = lattice(625, 25);
    // A disc in the middle of the lattice.
    const centre = { x: 12 * 25, y: 12 * 25 };
    const targets: number[] = [];
    observations.forEach((observation, index) => {
      if (Math.hypot(observation.x - centre.x, observation.y - centre.y) < 80) targets.push(index);
    });
    expect(targets.length).toBeGreaterThan(8);

    const { baseState, solved } = perturb('TGFB1', targets, observations);
    const delta = stateDelta(baseState, solved.stages[solved.stages.length - 1] as ReturnType<typeof emptyState>);
    const touched = new Set(targets);

    const band = (low: number, high: number): number => {
      let total = 0;
      let count = 0;
      observations.forEach((observation, index) => {
        if (touched.has(index)) return;
        const distance = Math.hypot(observation.x - centre.x, observation.y - centre.y);
        if (distance < low || distance >= high) return;
        total += delta[index] as number;
        count += 1;
      });
      return count > 0 ? total / count : 0;
    };

    const near = band(80, 140);
    const mid = band(140, 220);
    const far = band(300, 500);

    expect(near).toBeGreaterThan(1e-4);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
  });

  it('propagates further from a ligand than from its receptor', () => {
    const observations = lattice(400, 25);
    const targets = observations.map((_, index) => index).filter((index) => index % 3 === 0);

    const ligand = perturb('TGFB1', targets, observations);
    const receptor = perturb('TGFBR1', targets, observations);

    const bystanderMean = (run: ReturnType<typeof perturb>): number => {
      const delta = stateDelta(run.baseState, run.solved.stages[run.solved.stages.length - 1] as ReturnType<typeof emptyState>);
      const touched = new Set(targets);
      let total = 0;
      let count = 0;
      for (let i = 0; i < observations.length; i += 1) {
        if (touched.has(i)) continue;
        total += delta[i] as number;
        count += 1;
      }
      return count > 0 ? total / count : 0;
    };

    /*
     * A ligand knockout removes what the neighbours receive; a receptor
     * knockout removes only what the target cell can hear. If these came out
     * the same the mechanism would be propagating a label rather than a signal,
     * and the model trained on it would learn nothing worth having.
     */
    expect(bystanderMean(ligand)).toBeGreaterThan(bystanderMean(receptor) * 2);
  });
});

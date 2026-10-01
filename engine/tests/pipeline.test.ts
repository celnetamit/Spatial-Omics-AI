/**
 * The stage graph and the state machine of §10.3.
 *
 * The state is *derived* from which stages have completed, not stored. These
 * tests are what keeps that true: a status field somebody remembers to update
 * is a status field that will eventually be wrong, and a project reporting
 * COMPLETE with no comparison is a bug that only surfaces when the report is
 * opened.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveState, stageIsRunnable, ERROR_IS_RECOVERABLE, ERROR_SUGGESTION,
  STAGE_DEPENDENCIES, STAGE_STEP, STAGE_TITLE, type StageId,
} from '../src/pipeline';

const ALL: StageId[] = Object.keys(STAGE_DEPENDENCIES) as StageId[];

describe('the stage graph', () => {
  it('names every stage with a title and a handbook step', () => {
    for (const stage of ALL) {
      expect(STAGE_TITLE[stage]?.length ?? 0).toBeGreaterThan(0);
      expect(STAGE_STEP[stage]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('has no dependency on a stage that does not exist', () => {
    for (const stage of ALL) {
      for (const dependency of STAGE_DEPENDENCIES[stage]) {
        expect(ALL).toContain(dependency);
      }
    }
  });

  it('is acyclic', () => {
    const state = new Map<StageId, 'white' | 'grey' | 'black'>(ALL.map((stage) => [stage, 'white']));
    const visit = (stage: StageId, path: StageId[]): void => {
      if (state.get(stage) === 'grey') {
        throw new Error(`cycle: ${[...path, stage].join(' -> ')}`);
      }
      if (state.get(stage) === 'black') return;
      state.set(stage, 'grey');
      for (const dependency of STAGE_DEPENDENCIES[stage]) visit(dependency, [...path, stage]);
      state.set(stage, 'black');
    };
    expect(() => ALL.forEach((stage) => visit(stage, []))).not.toThrow();
  });

  it('refuses to run a stage whose dependencies are unmet, and names them', () => {
    const result = stageIsRunnable('propagation', new Set<StageId>(['ingest', 'qc']));
    expect(result.runnable).toBe(false);
    expect(result.missing).toContain('direct-response');
    expect(result.missing).toContain('graph');
  });

  it('allows a stage once its dependencies are met', () => {
    expect(stageIsRunnable('qc', new Set<StageId>(['ingest'])).runnable).toBe(true);
  });

  it('will not run QC before ingestion', () => {
    // This one is not hypothetical: a bundled case had already been ingested
    // and the project never recorded it, so every run was refused with
    // "Ingest and canonicalise has not completed" — correct logic applied to a
    // stage that had.
    expect(stageIsRunnable('qc', new Set<StageId>()).runnable).toBe(false);
  });
});

describe('the derived state', () => {
  const state = (stages: StageId[]): string => deriveState(new Set(stages), new Set()).state;

  it('walks forward as stages complete', () => {
    expect(state([])).toBe('DRAFT');
    expect(state(['ingest'])).toBe('DATA_READY');
    expect(state(['ingest', 'qc'])).toBe('QC_COMPLETE');
    expect(state(['ingest', 'qc', 'baseline', 'spatial'])).toBe('BASELINE_COMPLETE');
    expect(state(['ingest', 'qc', 'baseline', 'spatial', 'perturbation'])).toBe('EXPERIMENT_READY');
  });

  it('reaches COMPLETE only when the report has run', () => {
    const almost: StageId[] = [
      'ingest', 'qc', 'baseline', 'spatial', 'perturbation', 'graph',
      'direct-response', 'propagation', 'candidates', 'rescue-simulations',
    ];
    expect(state(almost)).not.toBe('COMPLETE');
    expect(state([...almost, 'report'])).toBe('COMPLETE');
  });

  it('reports a side state when a stage failed', () => {
    const derived = deriveState(new Set<StageId>(['ingest']), new Set<StageId>(['qc']));
    expect(derived.side).toContain('ERROR');
    // The forward state is unaffected: a failure does not un-complete a stage.
    expect(derived.state).toBe('DATA_READY');
  });
});

describe('the error taxonomy', () => {
  it('gives every code a recoverability and an action', () => {
    for (const code of Object.keys(ERROR_IS_RECOVERABLE) as (keyof typeof ERROR_IS_RECOVERABLE)[]) {
      expect(typeof ERROR_IS_RECOVERABLE[code]).toBe('boolean');
      expect(ERROR_SUGGESTION[code].length).toBeGreaterThan(10);
    }
  });

  it('marks out-of-domain as not recoverable by retrying', () => {
    // Running it again produces the same out-of-domain run.
    expect(ERROR_IS_RECOVERABLE.OUT_OF_DOMAIN).toBe(false);
    expect(ERROR_SUGGESTION.OUT_OF_DOMAIN).toContain('withheld');
  });
});

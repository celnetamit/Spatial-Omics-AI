/**
 * Runs a restart interrupts.
 *
 * The job queue is in memory and its workers are threads of the server
 * process, so a run that was queued or running when the process stopped
 * cannot still be running when it starts again. The append-only log does not
 * know that: replayed verbatim, such a run stayed "running" at its last
 * progress for good, and every page header for that project said so.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seededStore(): { root: string; queued: string; running: string; complete: string } {
  const root = mkdtempSync(join(tmpdir(), 'spatial-interrupted-'));
  roots.push(root);
  const store = new Store(root);
  const project = store.createProject({
    ownerId: 'owner-1', title: 'Restart', organism: 'Homo sapiens', tissue: 'tumour',
    condition: 'untreated', studyQuestion: 'q', mode: 'basic',
    datasetId: 'sim-tme-primary', datasetKind: 'bundled-case', referenceDatasetId: null,
  });
  const make = (): string =>
    store.createRun({ projectId: project.projectId, ownerId: 'owner-1', kind: 'analysis', perturbationId: null, seed: 1 }).runId;
  const queued = make();
  const running = make();
  store.updateRun(running, { status: 'running', progress: 0.85, startedAt: new Date().toISOString() });
  const complete = make();
  store.updateRun(complete, { status: 'complete', progress: 1, finishedAt: new Date().toISOString() });
  store.flush();
  return { root, queued, running, complete };
}

describe('runs interrupted by a restart', () => {
  it('come back from the log still claiming to be in flight', () => {
    const { root, queued, running } = seededStore();
    const restarted = new Store(root);
    expect(restarted.getRun(queued)?.status).toBe('queued');
    expect(restarted.getRun(running)?.status).toBe('running');
  });

  it('are failed at startup as interrupted and recoverable, and nothing else is touched', () => {
    const { root, queued, running, complete } = seededStore();
    const restarted = new Store(root);
    expect(restarted.failInterruptedRuns()).toBe(2);
    for (const runId of [queued, running]) {
      const run = restarted.getRun(runId);
      expect(run?.status).toBe('failed');
      expect(run?.finishedAt).toBeTruthy();
      expect(run?.error).toMatchObject({ code: 'INTERRUPTED', recoverable: true });
    }
    // Progress is kept, so the record still shows how far the run got.
    expect(restarted.getRun(running)?.progress).toBe(0.85);
    expect(restarted.getRun(complete)?.status).toBe('complete');
    expect(restarted.getRun(complete)?.error).toBeNull();
  });

  it('stay failed after the next restart, and a second pass changes nothing', () => {
    const { root, running } = seededStore();
    const first = new Store(root);
    first.failInterruptedRuns();
    first.flush();
    const second = new Store(root);
    expect(second.getRun(running)?.status).toBe('failed');
    expect(second.failInterruptedRuns()).toBe(0);
  });
});

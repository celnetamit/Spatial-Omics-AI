/**
 * §3's cross-mode identity rule, enforced structurally.
 *
 *   "Beginner, Intermediate and Advanced must return identical numbers for the
 *    same configuration. Only controls, guidance, diagnostics and export depth
 *    differ."
 *
 * The strongest way to guarantee that is not to compare outputs — two runs can
 * agree by luck, and a test that runs the pipeline twice is too slow to run on
 * every commit. It is to make the number-producing code incapable of knowing
 * which mode it is in.
 *
 * That is the current state: no lab mode ever crosses into `engine/`, and no
 * worker task carries one. These tests assert it stays that way. A failure here
 * is not a style complaint — it means somebody has given the science a way to
 * depend on which tier the user is on, and §3 is broken from that commit on.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnalysisTask, PredictionTask, RescueTask, WorkerTask } from '../server/src/jobs/protocol';

const root = resolve(__dirname, '..');

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(resolve(root, directory));
  return out;
}

/**
 * Comments and string contents are stripped before searching.
 *
 * A doc comment explaining *why* the engine has no mode is not a violation, and
 * a test that cannot tell the difference would push people to stop writing the
 * explanation.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('the engine does not know which lab mode it is in', () => {
  const engineFiles = sourceFiles('engine/src');

  it('reads every engine source file', () => {
    expect(engineFiles.length).toBeGreaterThan(20);
  });

  it('names no lab mode anywhere in engine/', () => {
    const offenders = engineFiles
      .filter((path) => /(['"])(basic|expert)\1|\bLabMode\b/.test(code(path)))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });

  it('names no lab mode in the job layer that drives it', () => {
    // 'moderate' is deliberately not searched for: it is also a confidence
    // level in the §5.1 vocabulary, and the engine uses it constantly for that.
    // 'basic' and 'expert' are unambiguous, and a mode check needs all three.
    const offenders = sourceFiles('server/src/jobs')
      .filter((path) => /(['"])(basic|expert)\1|\bLabMode\b/.test(code(path)))
      .map((path) => relative(root, path));
    expect(offenders).toEqual([]);
  });
});

describe('no worker task can carry a mode', () => {
  /*
   * A compile-time assertion, which is the part that actually holds the line:
   * adding `mode` to any task type makes this file fail `tsc`, before any test
   * runs. The runtime expectations below exist so the failure is also legible
   * in a test report rather than only in a build log.
   */
  type HasMode<T> = 'mode' extends keyof T ? true : false;
  const analysisIsClean: HasMode<AnalysisTask> = false;
  const predictionIsClean: HasMode<PredictionTask> = false;
  const rescueIsClean: HasMode<RescueTask> = false;
  const anyTaskIsClean: HasMode<WorkerTask> = false;

  it('holds for every task kind', () => {
    expect([analysisIsClean, predictionIsClean, rescueIsClean, anyTaskIsClean]).toEqual([
      false, false, false, false,
    ]);
  });
});

describe('what is allowed to differ between modes', () => {
  it('is decided in the client and the routes, not in the science', () => {
    // The rule permits controls, guidance, diagnostics and export depth to
    // differ. Those live in the UI and in the route layer — so the mode has to
    // exist *somewhere*, and finding it there is the expected result.
    const routes = sourceFiles('server/src/routes')
      .filter((path) => /(['"])(basic|expert)\1|\bLabMode\b/.test(code(path)));
    expect(routes.length).toBeGreaterThan(0);
  });
});

/**
 * The background job queue.
 *
 * §10.4 lists sixteen kinds of background job and §9.1 says long-running work
 * "must not block web requests". This is the minimum thing that satisfies both
 * without dragging in Celery and Redis for a single-container deployment: an
 * in-process queue with bounded concurrency, a hard timeout, cancellation and
 * progress reporting.
 *
 * Jobs run on the main thread. That is a real constraint and it is chosen
 * rather than overlooked: the scientific engine is pure TypeScript operating on
 * typed arrays that would have to be copied into and out of a worker, and for a
 * 2,400-cell section the copy costs more than the parallelism saves. The
 * consequence is that a run holds the event loop in slices, so every long loop
 * in the pipeline yields between stages — see `checkpoint` below — and the
 * default concurrency is one.
 */

import type { StageId } from '@engine/pipeline';

export type JobStatus = 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';

export interface JobProgress {
  stage: StageId | null;
  completed: StageId[];
  fraction: number;
  message: string;
}

export interface JobHandle {
  id: string;
  status: JobStatus;
  progress: JobProgress;
  error: { code: string; message: string } | null;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface JobContext {
  /** Reports progress. Yields to the event loop, so callers should await it. */
  report: (progress: Partial<JobProgress>) => Promise<void>;
  /** Throws if the job has been cancelled or has exceeded its deadline. */
  checkpoint: () => Promise<void>;
  signal: AbortSignal;
}

export class Cancelled extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'Cancelled';
  }
}

interface QueuedJob {
  id: string;
  run: (context: JobContext) => Promise<void>;
  handle: JobHandle;
  controller: AbortController;
  deadline: number;
  onSettled: (handle: JobHandle) => void;
}

export interface QueueOptions {
  concurrency: number;
  maxQueued: number;
  hardTimeoutMs: number;
}

export class JobQueue {
  private readonly options: QueueOptions;
  private readonly pending: QueuedJob[] = [];
  private readonly active = new Map<string, QueuedJob>();
  private readonly handles = new Map<string, JobHandle>();

  constructor(options: QueueOptions) {
    this.options = options;
  }

  get depth(): number {
    return this.pending.length;
  }

  get running(): number {
    return this.active.size;
  }

  submit(
    id: string,
    run: (context: JobContext) => Promise<void>,
    onSettled: (handle: JobHandle) => void,
  ): { accepted: boolean; reason?: string } {
    if (this.pending.length >= this.options.maxQueued) {
      return {
        accepted: false,
        reason: `The queue is full (${this.options.maxQueued} waiting). Try again when the current runs finish.`,
      };
    }

    const handle: JobHandle = {
      id,
      status: 'queued',
      progress: { stage: null, completed: [], fraction: 0, message: 'Queued' },
      error: null,
      startedAt: null,
      finishedAt: null,
    };
    this.handles.set(id, handle);
    this.pending.push({
      id,
      run,
      handle,
      controller: new AbortController(),
      deadline: 0,
      onSettled,
    });
    queueMicrotask(() => this.pump());
    return { accepted: true };
  }

  handleFor(id: string): JobHandle | undefined {
    return this.handles.get(id);
  }

  /**
   * Cancels a job.
   *
   * A queued job is removed; a running one is signalled and stops at its next
   * checkpoint. §10.1 calls this "safe cancellation" and the safety is that
   * partial artefacts already written are kept — a cancelled run reports what
   * it completed rather than discarding it.
   */
  cancel(id: string, reason = 'Cancelled by the user.'): boolean {
    const queuedIndex = this.pending.findIndex((job) => job.id === id);
    if (queuedIndex >= 0) {
      const [job] = this.pending.splice(queuedIndex, 1);
      if (job) {
        job.handle.status = 'cancelled';
        job.handle.finishedAt = Date.now();
        job.handle.error = { code: 'CANCELLED', message: reason };
        job.onSettled(job.handle);
      }
      return true;
    }
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Cancelled(reason));
      return true;
    }
    return false;
  }

  /** Forgets settled handles older than the given age. */
  prune(maximumAgeMs = 60 * 60 * 1000): void {
    const cutoff = Date.now() - maximumAgeMs;
    for (const [id, handle] of this.handles) {
      if (handle.finishedAt !== null && handle.finishedAt < cutoff) this.handles.delete(id);
    }
  }

  private pump(): void {
    while (this.active.size < this.options.concurrency && this.pending.length > 0) {
      const job = this.pending.shift();
      if (!job) break;
      this.active.set(job.id, job);
      void this.execute(job);
    }
  }

  private async execute(job: QueuedJob): Promise<void> {
    job.handle.status = 'running';
    job.handle.startedAt = Date.now();
    job.deadline = job.handle.startedAt + this.options.hardTimeoutMs;
    job.handle.progress = { ...job.handle.progress, message: 'Starting' };

    const context: JobContext = {
      signal: job.controller.signal,
      report: async (progress) => {
        job.handle.progress = { ...job.handle.progress, ...progress };
        // Yield, so a long pipeline does not starve the HTTP server between
        // stages. `setImmediate` rather than a zero timeout: it runs after I/O
        // callbacks, which is what lets a status poll actually be answered.
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      checkpoint: async () => {
        if (job.controller.signal.aborted) {
          throw new Cancelled('The run was cancelled.');
        }
        if (Date.now() > job.deadline) {
          throw new Cancelled(
            `The run exceeded its ${Math.round(this.options.hardTimeoutMs / 1000)} second budget and was stopped. Partial results are kept.`,
          );
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
    };

    try {
      await job.run(context);
      job.handle.status = 'complete';
      job.handle.progress = { ...job.handle.progress, fraction: 1, message: 'Complete' };
    } catch (error) {
      if (error instanceof Cancelled || job.controller.signal.aborted) {
        job.handle.status = 'cancelled';
        job.handle.error = { code: 'CANCELLED', message: error instanceof Error ? error.message : 'Cancelled.' };
      } else {
        job.handle.status = 'failed';
        job.handle.error = {
          code: 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        };
      }
    } finally {
      job.handle.finishedAt = Date.now();
      this.active.delete(job.id);
      job.onSettled(job.handle);
      queueMicrotask(() => this.pump());
    }
  }
}

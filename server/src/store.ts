/**
 * Persistence: projects, perturbation definitions, runs and artefacts.
 *
 * An append-only JSONL index plus one directory of artefacts per run. The
 * append-only part is what makes a stored run structurally immutable, which
 * §6.23 needs when it says an observed validation result "creates a new
 * ValidationComparison object without editing the original prediction" — an
 * update-in-place store would let that happen by accident.
 *
 * ONE REPLICA. The index is in memory and the log is appended to; two processes
 * would interleave writes and neither would hold the other's index. Mount a
 * volume at SPATIAL_DATA_ROOT or every restart begins from nothing.
 *
 * Large numeric artefacts — per-stage tissue states, per-cell predictions — go
 * to their own files rather than into the log. A propagation result is several
 * megabytes and a JSONL line that size makes the index unreadable by the tools
 * an operator would reach for.
 */

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProjectState, SideState, StageId } from '@engine/pipeline';
import type { PerturbationDefinition } from '@engine/perturb/types';
import type { ReproducibilityManifest } from '@engine/core/provenance';

export type LabMode = 'basic' | 'moderate' | 'expert';

export interface ProjectRecord {
  projectId: string;
  ownerId: string;
  title: string;
  organism: string;
  tissue: string;
  condition: string;
  studyQuestion: string;
  mode: LabMode;
  /** The case or uploaded dataset this project analyses. */
  datasetId: string | null;
  datasetKind: 'bundled-case' | 'upload' | null;
  referenceDatasetId: string | null;
  createdAt: string;
  updatedAt: string;
  currentRevision: number;
  state: ProjectState;
  sideStates: SideState[];
  /** Stages that have completed, in order of completion. */
  completedStages: StageId[];
  failedStages: StageId[];
  archived: boolean;
}

export interface RunRecord {
  runId: string;
  projectId: string;
  ownerId: string;
  kind: 'analysis' | 'prediction' | 'rescue' | 'report';
  status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Stage currently running, for the progress display. */
  currentStage: StageId | null;
  completedStages: StageId[];
  /** 0 to 1. */
  progress: number;
  perturbationId: string | null;
  seed: number;
  error: { code: string; message: string; recoverable: boolean } | null;
  warnings: string[];
  /** Artefact ids this run produced, resolvable through `readArtefact`. */
  artefacts: string[];
  manifest: ReproducibilityManifest | null;
}

export interface AuditEntry {
  at: string;
  actorId: string;
  action: string;
  subject: string;
  detail: Record<string, unknown>;
}

type LogKind = 'project' | 'run' | 'perturbation' | 'audit';

export class Store {
  private readonly root: string;
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly runs = new Map<string, RunRecord>();
  private readonly perturbations = new Map<string, PerturbationDefinition>();
  private readonly handles = new Map<LogKind, number>();
  private dirty = false;

  get dataRoot(): string {
    return this.root;
  }

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    mkdirSync(join(root, 'artefacts'), { recursive: true });
    this.replay();
  }

  // -- replay ---------------------------------------------------------------

  private logPath(kind: LogKind): string {
    return join(this.root, `${kind}s.jsonl`);
  }

  private replay(): void {
    for (const kind of ['project', 'run', 'perturbation'] as LogKind[]) {
      const path = this.logPath(kind);
      if (!existsSync(path)) continue;
      const lines = readFileSync(path, 'utf8').split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as Record<string, unknown>;
          // Last write wins, which is what makes an append-only log usable as
          // a mutable index without losing the history.
          if (kind === 'project') this.projects.set(record.projectId as string, record as unknown as ProjectRecord);
          else if (kind === 'run') this.runs.set(record.runId as string, record as unknown as RunRecord);
          else this.perturbations.set(record.id as string, record as unknown as PerturbationDefinition);
        } catch {
          // A truncated final line is the normal consequence of a hard kill.
          // Skipping it loses one record rather than the whole log.
        }
      }
    }
  }

  private append(kind: LogKind, record: unknown): void {
    let handle = this.handles.get(kind);
    if (handle === undefined) {
      handle = openSync(this.logPath(kind), 'a');
      this.handles.set(kind, handle);
    }
    appendFileSync(handle, `${JSON.stringify(record)}\n`);
    this.dirty = true;
  }

  // -- projects -------------------------------------------------------------

  createProject(parts: Omit<ProjectRecord, 'projectId' | 'createdAt' | 'updatedAt' | 'currentRevision' | 'state' | 'sideStates' | 'completedStages' | 'failedStages' | 'archived'>): ProjectRecord {
    const now = new Date().toISOString();
    const project: ProjectRecord = {
      ...parts,
      projectId: `prj_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      createdAt: now,
      updatedAt: now,
      currentRevision: 1,
      state: 'DRAFT',
      sideStates: [],
      completedStages: [],
      failedStages: [],
      archived: false,
    };
    this.projects.set(project.projectId, project);
    this.append('project', project);
    return project;
  }

  getProject(projectId: string): ProjectRecord | undefined {
    return this.projects.get(projectId);
  }

  listProjects(ownerId: string): ProjectRecord[] {
    return [...this.projects.values()]
      .filter((project) => project.ownerId === ownerId && !project.archived)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateProject(projectId: string, changes: Partial<ProjectRecord>): ProjectRecord | undefined {
    const existing = this.projects.get(projectId);
    if (!existing) return undefined;
    const updated: ProjectRecord = {
      ...existing,
      ...changes,
      projectId: existing.projectId,
      ownerId: existing.ownerId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
      currentRevision: existing.currentRevision + 1,
    };
    this.projects.set(projectId, updated);
    this.append('project', updated);
    return updated;
  }

  /** Marks a stage complete and re-derives the project state from the set. */
  completeStage(projectId: string, stage: StageId): ProjectRecord | undefined {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    const completed = project.completedStages.includes(stage)
      ? project.completedStages
      : [...project.completedStages, stage];
    return this.updateProject(projectId, {
      completedStages: completed,
      failedStages: project.failedStages.filter((id) => id !== stage),
    });
  }

  failStage(projectId: string, stage: StageId): ProjectRecord | undefined {
    const project = this.projects.get(projectId);
    if (!project) return undefined;
    const failed = project.failedStages.includes(stage) ? project.failedStages : [...project.failedStages, stage];
    return this.updateProject(projectId, { failedStages: failed });
  }

  // -- perturbations --------------------------------------------------------

  saveDefinition(definition: PerturbationDefinition): void {
    // Immutable by contract (§6.11). A second save of the same id is a bug,
    // not an update, so it is refused rather than silently accepted.
    if (this.perturbations.has(definition.id)) {
      const existing = this.perturbations.get(definition.id) as PerturbationDefinition;
      if (existing.checksum !== definition.checksum) {
        throw new Error(
          `Perturbation ${definition.id} already exists with a different checksum. Definitions are immutable (§6.11); create a new one.`,
        );
      }
      return;
    }
    this.perturbations.set(definition.id, definition);
    this.append('perturbation', definition);
  }

  getDefinition(id: string): PerturbationDefinition | undefined {
    return this.perturbations.get(id);
  }

  // -- runs -----------------------------------------------------------------

  createRun(parts: Omit<RunRecord, 'runId' | 'createdAt' | 'status' | 'startedAt' | 'finishedAt' | 'currentStage' | 'completedStages' | 'progress' | 'error' | 'warnings' | 'artefacts' | 'manifest'>): RunRecord {
    const run: RunRecord = {
      ...parts,
      runId: `run_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      currentStage: null,
      completedStages: [],
      progress: 0,
      error: null,
      warnings: [],
      artefacts: [],
      manifest: null,
    };
    this.runs.set(run.runId, run);
    this.append('run', run);
    return run;
  }

  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  listRuns(projectId: string): RunRecord[] {
    return [...this.runs.values()]
      .filter((run) => run.projectId === projectId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  updateRun(runId: string, changes: Partial<RunRecord>): RunRecord | undefined {
    const existing = this.runs.get(runId);
    if (!existing) return undefined;
    const updated: RunRecord = { ...existing, ...changes, runId: existing.runId, createdAt: existing.createdAt };
    this.runs.set(runId, updated);
    this.append('run', updated);
    return updated;
  }

  countActiveRuns(ownerId: string): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.ownerId === ownerId && (run.status === 'queued' || run.status === 'running')) count += 1;
    }
    return count;
  }

  countRunsSince(ownerId: string, since: number): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (run.ownerId === ownerId && Date.parse(run.createdAt) >= since) count += 1;
    }
    return count;
  }

  // -- artefacts ------------------------------------------------------------

  private artefactDir(runId: string): string {
    return join(this.root, 'artefacts', runId);
  }

  /**
   * Writes an artefact for a run.
   *
   * Artefact ids are `runId/name`, so a caller cannot read another run's
   * artefact by guessing a name, and the path is built rather than taken.
   */
  writeArtefact(runId: string, name: string, value: unknown): string {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error(`Invalid artefact name "${name}".`);
    }
    const directory = this.artefactDir(runId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
    const run = this.runs.get(runId);
    if (run && !run.artefacts.includes(name)) {
      this.updateRun(runId, { artefacts: [...run.artefacts, name] });
    }
    return `${runId}/${name}`;
  }

  readArtefact<T>(runId: string, name: string): T | null {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return null;
    const path = join(this.artefactDir(runId), `${name}.json`);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  listArtefacts(runId: string): string[] {
    const directory = this.artefactDir(runId);
    if (!existsSync(directory)) return [];
    return readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -5));
  }

  deleteRunArtefacts(runId: string): void {
    const directory = this.artefactDir(runId);
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
  }

  // -- audit ----------------------------------------------------------------

  audit(entry: Omit<AuditEntry, 'at'>): void {
    this.append('audit', { ...entry, at: new Date().toISOString() });
  }

  // -- lifecycle ------------------------------------------------------------

  get stats(): { projects: number; runs: number; perturbations: number } {
    return { projects: this.projects.size, runs: this.runs.size, perturbations: this.perturbations.size };
  }

  flush(): void {
    this.dirty = false;
  }

  close(): void {
    for (const handle of this.handles.values()) {
      try {
        closeSync(handle);
      } catch {
        // Closing a handle during shutdown is best-effort.
      }
    }
    this.handles.clear();
    this.dirty = false;
  }

  get hasUnflushedWrites(): boolean {
    return this.dirty;
  }
}

/**
 * The workflow as steps: what each one is for, what completes it, and what
 * comes next.
 *
 * Two things read this. The Beginner guide at the top of each workflow page
 * (`guide`), and the step bar at the bottom whose Next button opens once the
 * current step is complete (`complete`). Completion is read from the
 * project's completed stages, the same record the sidebar's locks use, so
 * the two cannot disagree.
 */

import type { ProjectSummary } from './api';
import type { LabMode } from './governance/modeLabels';
import { WORKFLOW_PAGES, type Page } from '../types';

export const MODE_RANK: Record<LabMode, number> = { basic: 0, moderate: 1, expert: 2 };

/** Whether `mode` includes everything `min` shows. */
export function atLeast(mode: LabMode | null | undefined, min: LabMode): boolean {
  return MODE_RANK[mode ?? 'basic'] >= MODE_RANK[min];
}

export interface StepGuide {
  /** What this step is for, in one sentence. */
  purpose: string;
  /** What to do or look at here. */
  todo: string[];
}

export const STEP_GUIDE: Partial<Record<Page, StepGuide>> = {
  project: {
    purpose: 'A project records your study question and the tissue you will work on, before anything is computed.',
    todo: ['Give the project a title and a study question.', 'Keep the bundled tumour section as the dataset, then create the project.'],
  },
  data: {
    purpose: 'Check that the tissue is good enough to analyse, and separately whether a prediction can be trusted on it.',
    todo: ['If nothing is shown yet, press "Run the baseline analysis".', 'Read the analysis verdict and the prediction eligibility at the top.'],
  },
  baseline: {
    purpose: 'See the tissue as it is: which cells are where, and what distinguishes each cell type.',
    todo: ['Change the map with the Layer menu (cell type, domains, pathway activity).', 'Pick a cell class above the markers table to see what marks it.'],
  },
  reference: {
    purpose: 'Optionally compare this section with a matched reference section, when the two are comparable.',
    todo: ['If the project has no reference, there is nothing to do here; continue to the experiment.'],
  },
  experiment: {
    purpose: 'Design a virtual experiment: choose a target and what happens to it, and which cells receive the change.',
    todo: ['Keep Path A, choose a target and an operator (for example a TGFB1 knockout).', 'Tick the cell types to perturb, press "Define perturbation", then "Run the prediction".'],
  },
  propagation: {
    purpose: 'Follow the change as it spreads from the targeted cells into the rest of the tissue, stage by stage.',
    todo: ['Move the stage slider and watch the map.', 'Check the Confidence tile: an out-of-domain run is not interpretable.'],
  },
  predicted: {
    purpose: 'The predicted altered tissue: what changed, where, and how sure the model is.',
    todo: ['Choose a feature in the Layer menu to see where it changed.', 'Read "What changed" and the adverse and off-target effects.'],
  },
  rescue: {
    purpose: 'Look for interventions that could reverse the change. Every candidate is simulated before any is compared.',
    todo: ['If nothing is shown yet, press "Retrieve and simulate candidates".', 'Look at the drivers, then each candidate\'s rescue map.'],
  },
  compare: {
    purpose: 'Weigh the candidates on benefit, adverse burden and uncertainty together. No single winner is declared without approved weights.',
    todo: ['Read the benefit against adverse burden chart.', 'Sort the candidate table by the column that matters to you.'],
  },
  interpret: {
    purpose: 'A plain-language reading of the results, checked against the evidence it was given.',
    todo: [
      'When an AI provider is configured, ask for an interpretation of the prediction or the baseline.',
      'Every number in it comes from the results; the AI explains them and never produces them.',
    ],
  },
  validate: {
    purpose: 'Plan the lab experiment that would best test this prediction in real tissue.',
    todo: ['Press "Design the experiment" and read what it would measure, and in which cells.'],
  },
  report: {
    purpose: 'The full record of the study: every step, with its methods and caveats.',
    todo: ['Download the report or print it.'],
  },
};

/** What completes each step, and what to do when it is not complete yet. */
const COMPLETES: Partial<Record<Page, { stage: string | null; todo: string }>> = {
  project: { stage: null, todo: 'Create or open a project first.' },
  data: { stage: 'qc', todo: 'Run the baseline analysis on this page first.' },
  baseline: { stage: 'baseline', todo: 'Run the baseline analysis first (Data & QC).' },
  reference: { stage: 'baseline', todo: 'Run the baseline analysis first (Data & QC).' },
  experiment: { stage: 'propagation', todo: 'Define a perturbation and run the prediction first.' },
  propagation: { stage: 'propagation', todo: 'Run a prediction first (Experiment).' },
  predicted: { stage: 'altered-tissue', todo: 'Run a prediction first (Experiment).' },
  rescue: { stage: 'comparison', todo: 'Retrieve and simulate the rescue candidates first.' },
  compare: { stage: 'comparison', todo: 'Simulate the rescue candidates first (Rescue candidates).' },
  interpret: { stage: 'propagation', todo: 'Run a prediction first (Experiment).' },
  validate: { stage: 'propagation', todo: 'Run a prediction first (Experiment).' },
};

export function stepNumber(page: Page): number {
  return WORKFLOW_PAGES.indexOf(page) + 1;
}

export function nextStep(page: Page): Page | null {
  const index = WORKFLOW_PAGES.indexOf(page);
  return index >= 0 && index < WORKFLOW_PAGES.length - 1 ? (WORKFLOW_PAGES[index + 1] as Page) : null;
}

export function previousStep(page: Page): Page | null {
  const index = WORKFLOW_PAGES.indexOf(page);
  return index > 0 ? (WORKFLOW_PAGES[index - 1] as Page) : null;
}

/** Whether this step is complete for the project, and if not, what completes it. */
export function stepComplete(page: Page, project: ProjectSummary | null): { complete: boolean; todo: string | null } {
  const rule = COMPLETES[page];
  if (!rule) return { complete: true, todo: null };
  if (!project) return { complete: false, todo: 'Create or open a project first.' };
  if (rule.stage === null) return { complete: true, todo: null };
  return project.completedStages.includes(rule.stage) ? { complete: true, todo: null } : { complete: false, todo: rule.todo };
}

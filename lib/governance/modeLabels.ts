/**
 * What the three modes are called on screen.
 *
 * The internal ids stay `basic`, `moderate` and `expert`: they are written into
 * twenty-four content manifests, into every attempt already recorded, and into
 * the tier the hub returns. Renaming those would invalidate the manifest hashes
 * and silently change what a stored attempt means.
 *
 * The labels are a different matter, and they are Beginner / Intermediate /
 * Advanced because that is the vocabulary the rest of the Live Labs estate
 * uses. A learner who meets "Intermediate" in one lab and "Moderate" in the
 * next has to work out whether they are the same thing.
 */

export type LabMode = 'basic' | 'moderate' | 'expert';

export const MODE_LABEL: Record<LabMode, string> = {
  basic: 'Beginner',
  moderate: 'Intermediate',
  expert: 'Advanced',
};

/**
 * The one-line description of what a mode gives the learner in *this* lab.
 *
 * The labels above are shared vocabulary; these lines are not. They were
 * copied with this file from LogicLab and described guided and faulty
 * circuits. Each now names what the mode actually adds here (see the mode
 * filters in server/src/routes/results.ts).
 */
export const MODE_SUMMARY: Record<LabMode, string> = {
  basic: 'Beginner — the guided workflow, every result with its explanation',
  moderate: 'Intermediate — adds the diagnostics behind each step: preprocessing, annotation and graph checks',
  expert: 'Advanced — adds full provenance, the mechanistic reference, resistance detail and machine-readable export',
};

/** The label mid-sentence, e.g. "available in intermediate mode". */
export function modeName(mode: LabMode): string {
  return MODE_LABEL[mode];
}

/** A tier as the hub reports it, said the way a learner reads it. */
export function tierLabel(tier: string): string {
  return MODE_LABEL[(tier as LabMode)] ?? tier;
}

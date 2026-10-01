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

/** The one-line description of what a mode asks of the learner. */
export const MODE_SUMMARY: Record<LabMode, string> = {
  basic: 'Beginner — understand and complete guided circuits',
  moderate: 'Intermediate — diagnose and repair faulty circuits',
  expert: 'Advanced — design, verify, compare and justify',
};

/** The label mid-sentence, e.g. "available in intermediate mode". */
export function modeName(mode: LabMode): string {
  return MODE_LABEL[mode];
}

/** A tier as the hub reports it, said the way a learner reads it. */
export function tierLabel(tier: string): string {
  return MODE_LABEL[(tier as LabMode)] ?? tier;
}

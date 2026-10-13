/**
 * The guide at the top of a workflow step and the step bar at the bottom.
 *
 * The guide is Beginner mode's: what the step is for and what to do in it.
 * The Next button is every mode's: it opens once this step is complete
 * (read from the project's completed stages), and until then its tooltip
 * says what completes it.
 */

import { ArrowRight, Compass } from 'lucide-react';
import type { ProjectSummary } from '../../lib/api';
import { STEP_GUIDE, nextStep, stepComplete, stepNumber } from '../../lib/steps';
import { PAGE_TITLES, WORKFLOW_PAGES, type Page } from '../../types';

export function StepGuide({ page }: { page: Page }): React.ReactElement | null {
  const guide = STEP_GUIDE[page];
  if (!guide) return null;
  return (
    <aside className="step-guide" aria-label="Beginner guide">
      <span className="step-guide__icon" aria-hidden="true">
        <Compass size={18} strokeWidth={2} />
      </span>
      <div className="min-w-0">
        <p className="step-guide__eyebrow">
          Beginner guide · Step {stepNumber(page)} of {WORKFLOW_PAGES.length}
        </p>
        <p className="step-guide__purpose">{guide.purpose}</p>
        <ul className="step-guide__todo">
          {guide.todo.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="step-guide__hint">
          Intermediate and Advanced add the diagnostics and the provenance behind each step. Change mode at the top of the
          page.
        </p>
      </div>
    </aside>
  );
}

export function StepNav({
  page,
  project,
  navigate,
}: {
  page: Page;
  project: ProjectSummary | null;
  navigate: (page: Page) => void;
}): React.ReactElement | null {
  if (!WORKFLOW_PAGES.includes(page)) return null;
  const next = nextStep(page);
  // The last step has nowhere to go, so nothing is shown.
  if (!next) return null;
  const { complete, todo } = stepComplete(page, project);
  /*
   * Only the Next button, at the bottom-right of the step (the product
   * owner's call). Where it goes, and what completes the step when it is
   * not ready yet, live in its accessible name and tooltip rather than as
   * text beside it.
   */
  return (
    <nav className="step-nav" aria-label="Next step">
      <button
        type="button"
        className="step-nav__next"
        onClick={() => navigate(next)}
        disabled={!complete}
        aria-label={complete ? `Next: ${PAGE_TITLES[next]}` : `Next: ${PAGE_TITLES[next]}. ${todo ?? ''}`.trim()}
        title={complete ? `Go to ${PAGE_TITLES[next]}` : (todo ?? undefined)}
      >
        Next
        <ArrowRight size={14} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </nav>
  );
}

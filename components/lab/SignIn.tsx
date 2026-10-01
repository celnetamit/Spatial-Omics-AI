/**
 * The sign-in screen.
 *
 * Reached when the launch token was absent, spent or refused. It distinguishes
 * *why*, because the two failures need different actions: a refusal sends
 * somebody to an administrator, and an unreachable portal is worth one more
 * try. Collapsing them into "could not sign in" costs an afternoon.
 */

import { ApiError } from '../../lib/api';
import { hadLaunchToken } from '../../lib/launch';
import { Button } from '../ui/Badges';

export default function SignIn({
  problem,
  loginUrl,
  homeUrl,
  onRetry,
}: {
  problem: ApiError | null;
  loginUrl: string;
  homeUrl: string;
  onRetry: () => void;
}): React.ReactElement {
  const transient = problem === null || problem.recoverable;
  const arrived = hadLaunchToken();

  return (
    <div className="flex h-full items-center justify-center px-6" style={{ background: 'var(--plane)' }}>
      <div
        className="w-full max-w-md rounded-lg border p-6"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <h1 className="text-base font-semibold" style={{ color: 'var(--ink)' }}>
          Sign in to open the lab
        </h1>

        <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          {problem === null
            ? 'This lab is opened from the Live Labs portal, which signs you in and sends you here.'
            : problem.message}
        </p>

        {problem?.suggestedAction ? (
          <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {problem.suggestedAction}
          </p>
        ) : null}

        {arrived && problem ? (
          <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            A launch token did arrive with this page, so the portal sent you here — the exchange for a session is what
            failed, not the link.
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          {transient ? (
            <Button variant="primary" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          <a
            href={loginUrl}
            className="rounded px-3 py-1.5 text-[12px] font-medium"
            style={{ border: '1px solid var(--border-strong)', color: 'var(--ink)' }}
          >
            Go to the portal
          </a>
          <a href={homeUrl} className="px-2 py-1.5 text-[12px] underline" style={{ color: 'var(--ink-secondary)' }}>
            All labs
          </a>
        </div>

        {problem?.requestId && problem.requestId !== 'client' ? (
          <p className="mt-4 font-mono text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            Reference {problem.requestId}
          </p>
        ) : null}
      </div>
    </div>
  );
}

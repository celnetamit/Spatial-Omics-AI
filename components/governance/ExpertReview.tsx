/**
 * The expert review form.
 *
 * Closed until the undertaking is signed, and it fails closed: if the portal
 * cannot confirm a signature the form stays shut, because being unable to
 * confirm one is not the same as knowing there is one. The screen says which
 * happened, so a locked reviewer can tell a network blip from a deployment gap.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type AgreementStatus, type SessionUser } from '../../lib/api';
import { REVIEW_ROLES, type ReviewRoleId } from '../../lib/governance/reviewerAgreement';
import { Button, Caveat, Section } from '../ui/Badges';

const DIMENSIONS = [
  { id: 'scientific-accuracy', label: 'Scientific or technical accuracy' },
  { id: 'methodology', label: 'Methodology and workflow' },
  { id: 'data-suitability', label: 'Dataset and input suitability' },
  { id: 'parameters', label: 'Parameters, assumptions and calculations' },
  { id: 'models', label: 'Algorithms, AI/ML models and computational logic' },
  { id: 'outputs', label: 'Outputs, visualisations and interpretation' },
  { id: 'reproducibility', label: 'Reproducibility and validation' },
  { id: 'education', label: 'Educational relevance and learner experience' },
  { id: 'limitations', label: 'Limitations, safety, privacy, security and ethics' },
] as const;

export default function ExpertReview({ labTitle, user }: { labTitle: string; user: SessionUser }): React.ReactElement {
  const [status, setStatus] = useState<AgreementStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [roles, setRoles] = useState<ReviewRoleId[]>([]);
  const [ratings, setRatings] = useState<Record<string, number>>({});
  const [findings, setFindings] = useState('');
  const [recommendation, setRecommendation] = useState('revise');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Set when this lab refused the check itself (403: not a reviewer).
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    // The session already says whether this is a reviewer, so a non-reviewer
    // gets the answer without a request the server would refuse with a 403.
    // The server check below stays the authority for everyone else.
    setRefusal(null);
    if (!user.isReviewer) {
      setRefusal('This account is not an expert reviewer.');
      setLoading(false);
      return;
    }
    void (async () => {
      try {
        setStatus(await api.agreementStatus());
      } catch (caught) {
        setStatus(null);
        /*
         * A 403 is this lab saying the account is not an expert reviewer. It
         * used to be reported as "the portal could not be reached", which
         * sends people looking for an outage that does not exist.
         */
        if (caught instanceof ApiError && caught.status === 403) setRefusal(caught.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [user.isReviewer]);

  if (loading) {
    return (
      <Section title="Expert review">
        <p className="text-xs" style={{ color: 'var(--ink-muted)' }}>
          Checking the agreement…
        </p>
      </Section>
    );
  }

  if (!status || !status.signed) {
    return (
      <Section title="Expert review" subtitle="Closed until the reviewer agreement is signed.">
        <Caveat tone="blocked">
          {refusal
            ? `${refusal} The expert review form is open to reviewers who have signed the agreement.`
            : status === null
            ? 'The portal could not be reached, so this lab cannot confirm whether the agreement is signed. The form stays closed — being unable to confirm a signature is not the same as knowing there is one.'
            : status.endpointPresent === false
              ? 'The portal has no reviewer-agreement endpoint. This is a deployment gap rather than a network problem, and the form stays closed.'
              : (status.reason ?? 'The agreement has not been signed for this lab.')}
        </Caveat>
      </Section>
    );
  }

  const submit = async (): Promise<void> => {
    if (findings.trim().length < 20) {
      setError('A review needs findings. Please describe what you examined and what you found.');
      return;
    }
    setState('sending');
    setError(null);
    try {
      await api.submitReview({ labTitle, reviewer: user.displayName, roles, ratings, findings: findings.trim(), recommendation });
      setState('sent');
    } catch (caught) {
      setState('idle');
      setError(caught instanceof ApiError ? caught.message : 'The review could not be recorded.');
    }
  };

  if (state === 'sent') {
    return (
      <Section title="Expert review">
        <Caveat>Your review was recorded. Thank you.</Caveat>
      </Section>
    );
  }

  return (
    <Section
      title="Expert review"
      subtitle={`Signed ${status.signedVersion ?? status.version}. Reviews are org-wide records held on the portal.`}
    >
      <div className="space-y-4">
        <fieldset>
          <legend className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Review role
          </legend>
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
            {REVIEW_ROLES.map((role) => (
              <label key={role.id} className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                <input
                  type="checkbox"
                  checked={roles.includes(role.id)}
                  onChange={() =>
                    setRoles((current) =>
                      current.includes(role.id) ? current.filter((r) => r !== role.id) : [...current, role.id],
                    )
                  }
                />
                {role.label}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="space-y-1.5">
          <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Assessment (1 unacceptable — 5 excellent; leave blank for not assessed)
          </p>
          {DIMENSIONS.map((dimension) => (
            <div key={dimension.id} className="flex items-center justify-between gap-3">
              <span className="text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                {dimension.label}
              </span>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((score) => (
                  <button
                    key={score}
                    type="button"
                    onClick={() =>
                      setRatings((current) => ({
                        ...current,
                        [dimension.id]: current[dimension.id] === score ? 0 : score,
                      }))
                    }
                    className="h-6 w-6 rounded text-[11px]"
                    style={{
                      border: '1px solid var(--border-strong)',
                      background: ratings[dimension.id] === score ? 'var(--series-1)' : 'transparent',
                      color: ratings[dimension.id] === score ? '#fff' : 'var(--ink-secondary)',
                    }}
                  >
                    {score}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Findings, errors, omissions and recommended improvements
          </span>
          <textarea
            value={findings}
            rows={8}
            onChange={(event) => setFindings(event.target.value)}
            className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
            style={{ color: 'var(--ink)' }}
          />
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Overall recommendation
          </span>
          <select
            value={recommendation}
            onChange={(event) => setRecommendation(event.target.value)}
            className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
            style={{ color: 'var(--ink)' }}
          >
            <option value="release">Ready for release</option>
            <option value="revise">Release after the stated revisions</option>
            <option value="major">Major revision needed</option>
            <option value="hold">Do not release</option>
          </select>
        </label>

        {error ? <Caveat tone="warning">{error}</Caveat> : null}
        <Button variant="primary" onClick={() => void submit()} disabled={state === 'sending'}>
          {state === 'sending' ? 'Recording…' : 'Submit review'}
        </Button>
      </div>
    </Section>
  );
}

/**
 * AI interpretation — §6.9, §6.21 and §13.
 *
 * §6.9 requires the panel to separate Observed, Computed, Interpretation and
 * Limitations, and this screen does that literally: the evidence the model was
 * given is on the page beside what it said, so a reader who wants to check a
 * sentence does not have to take the citation on trust.
 *
 * When the gate rejects a response, the reader is told the explanation was
 * withheld and why — not shown a blank panel, and not shown the response with a
 * warning, because a warned-about fabricated number is still a fabricated
 * number on the screen.
 */

import { useState } from 'react';
import { api, ApiError, type InterpretationPayload } from '../../../lib/api';
import { Button, Caveat, ConfidenceBadge, ResultBadge, Section } from '../../ui/Badges';
import { EmptyState } from '../../ui/EmptyState';
import { useToast } from '../../ui/ToastContext';
import { duration, num } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

export default function InterpretPage({ context }: { context: WorkspaceContext }): React.ReactElement {
  const toast = useToast();
  const [payload, setPayload] = useState<InterpretationPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const runId = context.predictionRunId ?? context.analysisRunId;

  const request = async (stage: 'baseline' | 'final'): Promise<void> => {
    if (!runId) return;
    setLoading(true);
    try {
      setPayload(await api.interpretation(runId, stage));
    } catch (error) {
      if (error instanceof ApiError) toast.push('error', 'The interpretation could not be requested', error.message);
    } finally {
      setLoading(false);
    }
  };

  if (!runId) {
    return (
      <EmptyState
        title="There is nothing to interpret yet"
        explanation="Interpretation organises results that already exist and cites each one; it never produces a number of its own. Run the analysis first and the evidence it explains will be here."
        requires={{ page: 'data' }}
        onGo={context.navigate}
      />
    );
  }

  const interpretation = payload?.interpretation;
  const evidence = payload?.evidence;

  return (
    <div className="space-y-4">
      <Section
        title="What the AI layer is, and is not"
        subtitle="§13 — it explains structured results. It never produces a number, a map or a comparison."
      >
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          {context.meta?.ai.role}
        </p>
        {context.meta?.ai.unavailableReason ? (
          <Caveat tone="warning">{context.meta.ai.unavailableReason}</Caveat>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={loading || !context.meta?.ai.available}
            onClick={() => void request(context.predictionRunId ? 'final' : 'baseline')}
          >
            {loading ? 'Asking…' : context.predictionRunId ? 'Interpret the prediction' : 'Interpret the baseline'}
          </Button>
          {context.predictionRunId ? (
            <Button disabled={loading || !context.meta?.ai.available} onClick={() => void request('baseline')}>
              Interpret the baseline only
            </Button>
          ) : null}
        </div>
      </Section>

      {interpretation && !interpretation.available ? <Caveat tone="warning">{interpretation.message}</Caveat> : null}

      {interpretation?.gate && !interpretation.gate.accepted ? (
        <Section title="The explanation was withheld" badge={<ResultBadge label="INTERPRETED" />}>
          <Caveat tone="blocked">{interpretation.message}</Caveat>
          <div className="mt-3">
            <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              What the gate objected to
            </p>
            <ul className="ml-4 mt-1 list-disc space-y-0.5 text-[11.5px]" style={{ color: 'var(--ink-secondary)' }}>
              {interpretation.gate.rejections.map((rejection, index) => (
                <li key={index}>
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--status-critical-text)' }}>
                    {rejection.code}
                  </span>{' '}
                  {rejection.detail}
                </li>
              ))}
            </ul>
          </div>
          <p className="mt-3 text-[11px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            The checks are output validation, not prompt wording: a model that ignores every instruction it was given still
            cannot get past them. Everything else on this screen is unaffected — the numbers, maps and comparisons are
            produced by the analysis engine and do not pass through any language model.
          </p>
        </Section>
      ) : null}

      {interpretation?.response?.abstained ? (
        <Section title="The model abstained" badge={<ResultBadge label="INTERPRETED" />}>
          <Caveat>{interpretation.response.abstentionReason ?? interpretation.message}</Caveat>
          <p className="mt-2 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            Abstention is a correct answer, not a failure. §15.2 requires the lab to be able to say a result is not
            interpretable, and a system that can only ever return a confident answer has no way to.
          </p>
        </Section>
      ) : null}

      {interpretation?.response && !interpretation.response.abstained ? (
        <>
          {interpretation.response.findings.length > 0 ? (
            <Section title="Findings" badge={<ResultBadge label="INTERPRETED" method={interpretation.model} />}>
              <Statements entries={interpretation.response.findings} evidence={evidence} />
            </Section>
          ) : null}

          {interpretation.response.mechanism.length > 0 ? (
            <Section title="Mechanism" badge={<ResultBadge label="INTERPRETED" />}>
              <Statements entries={interpretation.response.mechanism} evidence={evidence} />
            </Section>
          ) : null}

          {interpretation.response.candidateComparison.length > 0 ? (
            <Section title="Candidate comparison" badge={<ResultBadge label="INTERPRETED" />}>
              <Statements entries={interpretation.response.candidateComparison} evidence={evidence} />
            </Section>
          ) : null}

          {interpretation.response.hypothesis ? (
            <Section title="Hypothesis" badge={<ResultBadge label="HYPOTHESIS" />}>
              <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>
                {interpretation.response.hypothesis.statement}
              </p>
              <p className="mt-2 text-[12px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                <span style={{ color: 'var(--ink-muted)' }}>How to test it: </span>
                {interpretation.response.hypothesis.howToTest}
              </p>
              <p className="mt-2 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                A testable interpretation, not an established fact.
              </p>
            </Section>
          ) : null}

          {interpretation.response.limitations.length > 0 ? (
            <Section title="Limitations" badge={<ResultBadge label="INTERPRETED" />}>
              <ul className="ml-4 list-disc space-y-1 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                {interpretation.response.limitations.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </Section>
          ) : null}

          <p className="text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            {interpretation.model} · prompt {interpretation.promptVersion} · policy {interpretation.policyVersion} ·{' '}
            {duration(interpretation.milliseconds)}. Prompt, response and gate verdict are audited.
          </p>
        </>
      ) : null}

      {evidence ? (
        <Section
          title="The evidence the model was given"
          subtitle="§13.2 — this is the whole input. A citation above points at one of these."
        >
          {evidence.notInterpretable ? <Caveat tone="blocked">{evidence.notInterpretable}</Caveat> : null}
          <div className="mt-2 space-y-2">
            {evidence.claims.map((claim) => (
              <div key={claim.id} className="rounded border px-2.5 py-2" style={{ borderColor: 'var(--border)' }}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                    {claim.id}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <ResultBadge label={claim.label} method={claim.method} />
                    <ConfidenceBadge confidence={claim.confidence} />
                  </span>
                </div>
                <p className="mt-1 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                  {claim.statement}
                </p>
                {claim.values.length > 0 ? (
                  <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                    {claim.values.map((value) => (
                      <li key={value.name} className="tnum">
                        {value.name} = {num(value.value, 4)} {value.unit}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>

          {evidence.missingEvidence.length > 0 ? (
            <div className="mt-3">
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Evidence that does not exist for this run
              </p>
              <ul className="ml-4 mt-1 list-disc text-[11.5px]" style={{ color: 'var(--ink-secondary)' }}>
                {evidence.missingEvidence.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <p className="mt-1 text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                Listed rather than omitted: "the adverse analysis did not run" and "there were no adverse effects" are
                different findings, and a model given neither would guess.
              </p>
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

function Statements({
  entries,
  evidence,
}: {
  entries: { statement: string; citedClaims: string[] }[];
  evidence: InterpretationPayload['evidence'] | undefined;
}): React.ReactElement {
  const known = new Set(evidence?.claims.map((claim) => claim.id) ?? []);
  return (
    <ul className="space-y-2.5">
      {entries.map((entry, index) => (
        <li key={index}>
          <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink)' }}>
            {entry.statement}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-1.5 font-mono text-[10px]" style={{ color: 'var(--ink-muted)' }}>
            {entry.citedClaims.map((id) => (
              <span
                key={id}
                className="rounded-sm border px-1"
                style={{ borderColor: known.has(id) ? 'var(--border)' : 'var(--status-critical)' }}
                title={known.has(id) ? 'Cited result' : 'This id is not in the evidence object.'}
              >
                {id}
              </span>
            ))}
          </p>
        </li>
      ))}
    </ul>
  );
}

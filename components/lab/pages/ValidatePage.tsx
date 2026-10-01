/**
 * Validation experiment and the prediction-versus-observation loop — §6.22,
 * §6.23 and §11.2.
 *
 * The recommendation is rule-backed rather than model-generated. The assay is
 * chosen where a large predicted change meets large ensemble disagreement,
 * because confirming something the model is already confident about resolves
 * nothing — and a bystander change is weighted higher, because that is the
 * spatial claim rather than the pharmacology.
 *
 * An uploaded observed result creates a *new* comparison object and never edits
 * the prediction. A prediction that can be revised after the fact is not a
 * prediction.
 */

import { useState } from 'react';
import { api, ApiError, type ValidationPlanPayload } from '../../../lib/api';
import type { RunDataState } from '../useRunData';
import { Button, Caveat, ConfidenceBadge, DataTable, ResultBadge, Section } from '../../ui/Badges';
import { ScatterChart } from '../../viz/Charts';
import { useToast } from '../../ui/ToastContext';
import { num } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

export default function ValidatePage({
  context,
  prediction,
}: {
  context: WorkspaceContext;
  prediction: RunDataState;
}): React.ReactElement {
  const toast = useToast();
  const [payload, setPayload] = useState<ValidationPlanPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [observedText, setObservedText] = useState('');
  const [comparison, setComparison] = useState<{ points: { symbol: string; predicted: number; observed: number }[]; correlation: number; note: string; unmatched: string[] } | null>(null);

  const runId = context.predictionRunId;
  const results = prediction.results?.prediction;

  if (!runId || !results) {
    return <Caveat>Run a prediction first — a validation experiment is designed around one.</Caveat>;
  }

  const design = async (): Promise<void> => {
    setLoading(true);
    try {
      setPayload(await api.validationPlan(runId));
    } catch (error) {
      if (error instanceof ApiError) toast.push('error', 'The plan could not be designed', error.message);
    } finally {
      setLoading(false);
    }
  };

  const compare = async (): Promise<void> => {
    const observed: Record<string, number> = {};
    for (const line of observedText.split('\n')) {
      const [symbol, value] = line.split(/[,\t=:]/).map((part) => part.trim());
      if (!symbol) continue;
      const parsed = Number.parseFloat(value ?? '');
      if (Number.isFinite(parsed)) observed[symbol.toUpperCase()] = parsed;
    }
    if (Object.keys(observed).length === 0) {
      toast.push('warning', 'Nothing to compare', 'Enter one "SYMBOL, change" per line.');
      return;
    }
    try {
      const result = await api.validationComparison(runId, observed, 'Uploaded observation');
      const body = result.comparison as unknown as {
        points: { symbol: string; predicted: number; observed: number }[];
        correlation: number;
        note: string;
        unmatched: string[];
      };
      setComparison(body);
      toast.push('success', 'Comparison stored', 'The original prediction is unchanged.');
    } catch (error) {
      if (error instanceof ApiError) toast.push('error', 'The comparison failed', error.message);
    }
  };

  const plan = payload?.plan;

  return (
    <div className="space-y-4">
      <Section
        title="Most informative validation experiment"
        subtitle="§6.22 — the assay is chosen by a rule, not generated. It has to measure the predicted feature and be feasible."
        badge={<ResultBadge label="VALIDATION" />}
        actions={
          <Button variant="primary" onClick={() => void design()} disabled={loading}>
            {loading ? 'Designing…' : plan ? 'Redesign' : 'Design the experiment'}
          </Button>
        }
      >
        {payload && !plan ? <Caveat>{payload.message}</Caveat> : null}
        {plan ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                {plan.question}
              </h3>
              <ConfidenceBadge confidence={plan.confidence} />
            </div>

            <dl className="grid gap-3 sm:grid-cols-2">
              <Field term="Assay" value={plan.assay.name} detail={`Spatial context: ${plan.assay.spatial ? 'preserved' : 'not preserved'}`} />
              <Field term="What to measure" value={plan.measure.join(', ')} />
              <Field term="If the prediction is right" value={plan.expectedIfCorrect} />
              <Field term="If it is wrong" value={plan.expectedIfWrong} />
            </dl>

            <div>
              <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Why this one
              </p>
              <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                {plan.rationale}
              </p>
            </div>

            {plan.alternativesConsidered.length > 0 ? (
              <div>
                <p className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                  Alternatives considered
                </p>
                <DataTable
                  rows={plan.alternativesConsidered}
                  columns={[
                    { key: 'a', header: 'Assay', render: (r) => r.assay },
                    { key: 'w', header: 'Why not', render: (r) => r.why },
                  ]}
                />
              </div>
            ) : null}

            <Caveat tone="warning">
              <p className="font-medium" style={{ color: 'var(--ink)' }}>
                Limitations
              </p>
              <ul className="ml-4 mt-1 list-disc">
                {plan.limitations.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
              <p className="mt-2">{plan.notAClinicalProtocol}</p>
            </Caveat>
          </div>
        ) : null}
      </Section>

      <Section
        title="Prediction versus observation"
        subtitle="§6.23 — an observed result creates a new comparison object. The prediction is never edited."
      >
        <p className="text-[12px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          Paste an observed change per feature, one per line, as <code>SYMBOL, value</code>. The comparison is made on the
          features present in both; predicted features the observation does not cover are excluded rather than treated as
          zero.
        </p>
        <textarea
          value={observedText}
          rows={6}
          onChange={(event) => setObservedText(event.target.value)}
          placeholder={'SMAD3, -0.12\nCOL1A1, -0.08\nACTA2, -0.05'}
          className="mt-2 w-full rounded border px-2 py-1.5 font-mono text-[11.5px]"
          style={{ color: 'var(--ink)' }}
        />
        <div className="mt-2">
          <Button variant="primary" onClick={() => void compare()}>
            Compare with the prediction
          </Button>
        </div>

        {comparison ? (
          <div className="mt-4 space-y-3">
            <Caveat>{comparison.note}</Caveat>
            {comparison.points.length > 1 ? (
              <>
                <ScatterChart
                  points={comparison.points.map((point) => ({ x: point.predicted, y: point.observed, label: point.symbol }))}
                  xLabel="Predicted change"
                  yLabel="Observed change"
                />
                <p className="text-[11.5px]" style={{ color: 'var(--ink-secondary)' }}>
                  Pearson r = <span className="tnum">{num(comparison.correlation, 3)}</span> across{' '}
                  {comparison.points.length} matched feature(s). The dashed line is y = x.
                </p>
              </>
            ) : null}
            {comparison.unmatched.length > 0 ? (
              <p className="text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                {comparison.unmatched.length} predicted feature(s) are not covered by this observation and were excluded.
              </p>
            ) : null}
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function Field({ term, value, detail }: { term: string; value: string; detail?: string }): React.ReactElement {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        {term}
      </dt>
      <dd className="mt-0.5 text-[12px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
        {value}
        {detail ? (
          <span className="mt-0.5 block text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
            {detail}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

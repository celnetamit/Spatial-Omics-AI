/**
 * Rescue candidates — §6.17 and §13.3.
 *
 * The rule this screen exists to make visible: nothing is ranked until every
 * eligible candidate has been simulated separately against the same altered
 * tissue state. So the eligible set is listed alphabetically, with no ordering
 * implied, and the excluded set is listed too — with the exact rule that
 * failed, because "not eligible" teaches nothing and "no dose-response
 * parameterisation, so there is no evidence-supported concentration to simulate
 * at" teaches what eligibility means.
 */

import { useState } from 'react';
import type { RunDataState } from '../useRunData';
import { useLayer } from '../useRunData';
import { Button, Caveat, DataTable, ResultBadge, Section, StatTile } from '../../ui/Badges';
import TissueView, { type LayerChoice } from '../TissueView';
import { BarChart } from '../../viz/Charts';
import { concentration, delta, integer, num } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

const REQUIREMENT_LABEL: Record<string, string> = {
  'stable-identifier': 'Stable compound identifier',
  'target-mechanism-evidence': 'Target and mechanism evidence',
  'target-in-feature-space': 'Target present in the model feature space',
  'model-pack-supports-class': 'Model pack supports this therapy class',
  'parameterisation-available': 'Dose-response parameterisation available',
  'context-policy': 'Evidence context policy',
};

export default function RescuePage({
  context,
  rescue,
}: {
  context: WorkspaceContext;
  rescue: RunDataState;
}): React.ReactElement {
  const results = rescue.results?.rescue;
  const observations = rescue.results?.observations;
  const [layerChoice, setLayerChoice] = useState<LayerChoice | null>(null);

  if (!context.predictionRunId) {
    return <Caveat>Run a prediction first — rescue candidates are retrieved from the altered tissue state it produces.</Caveat>;
  }

  if (!results) {
    return (
      <Section title="Rescue candidates" subtitle="§6.17 — a traceable list of interventions, with no candidate declared effective.">
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          Candidates are retrieved from the drivers of the altered tissue state, filtered by rule, and then every eligible one
          is simulated separately against the same altered state. Ranking happens only after that.
        </p>
        <div className="mt-3">
          <Button variant="primary" onClick={() => void context.submitRun('rescue', { stages: 5 })} disabled={Boolean(context.running)}>
            {context.running ? 'Running…' : 'Retrieve and simulate candidates'}
          </Button>
        </div>
      </Section>
    );
  }

  const points = observations ? observations.x.map((x, i) => ({ x, y: observations.y[i] as number })) : [];
  const complete = results.simulated.filter((entry) => entry.status === 'complete');
  const failed = results.simulated.filter((entry) => entry.status !== 'complete');

  const choices: LayerChoice[] = complete.map((entry) => ({
    id: `rescue:${entry.candidateId}`,
    label: entry.name,
    kind: 'rescue',
    key: entry.candidateId,
    group: 'Candidate rescue',
  }));
  const active = layerChoice ?? choices[0] ?? null;
  const layer = useLayer(context.rescueRunId, active?.kind ?? null, active?.key ?? '');

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Eligible" value={integer(results.eligible.length)} detail="Listed alphabetically — no ordering before simulation." />
        <StatTile label="Simulated" value={integer(complete.length)} detail="Each against the identical altered state." />
        <StatTile label="Excluded" value={integer(results.excluded.length)} detail="Each with the rule that failed." />
        <StatTile label="Drivers" value={integer(results.drivers.length)} detail="Features that moved most in the altered tissue." />
      </div>

      <Caveat>{results.simulationNote}</Caveat>

      <Section
        title="Drivers of the altered state"
        subtitle="§13.3 step 1 — what the retrieval was run against."
        badge={<ResultBadge label="PREDICTED" />}
      >
        <BarChart
          data={results.drivers.map((entry) => ({
            label: entry.symbol,
            value: entry.direction === 'up' ? entry.magnitude : -entry.magnitude,
          }))}
          valueLabel="Mean change from baseline"
          mode="diverging"
          formatValue={(value) => delta(value, 3)}
        />
      </Section>

      {complete.length > 0 ? (
        <Section title="Candidate rescue maps" subtitle="Each map is one candidate applied to the same altered tissue state.">
          <TissueView
            points={points}
            coordinateUnit={observations?.coordinateUnit ?? 'um'}
            layer={layer.layer}
            loading={layer.loading}
            error={layer.error}
            choices={choices}
            selectedId={active?.id ?? ''}
            onSelectLayer={setLayerChoice}
            height={440}
          />
        </Section>
      ) : null}

      <Section
        title="Eligible candidates"
        subtitle={results.retrievalNote}
      >
        <DataTable
          rows={results.eligible}
          maxHeight={340}
          columns={[
            { key: 'n', header: 'Candidate', render: (r) => r.name },
            { key: 't', header: 'Target', render: (r) => r.target },
            { key: 'c', header: 'Class', render: (r) => r.therapyClass },
            { key: 'm', header: 'Mechanism', render: (r) => r.mechanism },
            {
              key: 'conc',
              header: 'Simulated at',
              align: 'right',
              render: (r) => (r.suggestedConcentrationNm === null ? '—' : concentration(r.suggestedConcentrationNm)),
            },
            { key: 'e', header: 'Evidence', align: 'right', render: (r) => integer(r.evidence.length) },
          ]}
        />
        <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
          The simulated concentration is the median of the retrieved potency measurements — the concentration the evidence is
          densest at, rather than one chosen for effect. §6.18 forbids universal therapy parameter defaults, so a compound with
          no measurement has no suggested concentration and is excluded rather than simulated at something plausible.
        </p>
      </Section>

      <Section
        title="Excluded candidates"
        subtitle="§6.17 — the excluded table names which rule failed, so it is informative rather than a count."
      >
        <DataTable
          rows={results.excluded}
          maxHeight={340}
          columns={[
            { key: 'n', header: 'Candidate', render: (r) => r.name },
            { key: 't', header: 'Target', render: (r) => r.target },
            { key: 'c', header: 'Class', render: (r) => r.therapyClass },
            {
              key: 'f',
              header: 'Requirement not met',
              render: (r) => (
                <ul className="space-y-0.5">
                  {r.eligibility.failed.map((requirement) => (
                    <li key={requirement} style={{ color: 'var(--status-serious)' }}>
                      {REQUIREMENT_LABEL[requirement] ?? requirement}
                    </li>
                  ))}
                </ul>
              ),
            },
            {
              key: 'r',
              header: 'Reason',
              render: (r) => (
                <ul className="space-y-0.5">
                  {r.eligibility.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ),
            },
          ]}
          empty="No candidate was excluded."
        />
      </Section>

      {failed.length > 0 ? (
        <Section title="Simulations that failed" subtitle="§6.18 — one candidate's failure does not corrupt the others.">
          <DataTable
            rows={failed}
            columns={[
              { key: 'n', header: 'Candidate', render: (r) => r.name },
              { key: 'r', header: 'Reason', render: (r) => r.failureReason ?? '—' },
            ]}
          />
        </Section>
      ) : null}

      {complete.length > 0 ? (
        <Section title="Per-candidate outcome" subtitle="Components first. The comparison screen normalises them; these are the raw values.">
          <DataTable
            rows={complete}
            maxHeight={360}
            columns={[
              { key: 'n', header: 'Candidate', render: (r) => r.name },
              {
                key: 'c',
                header: 'Components',
                render: (r) => (
                  <ul className="space-y-0.5">
                    {r.components.map((component) => (
                      <li key={component.id}>
                        {component.name}: <span className="tnum">{num(component.value, 3)}</span>{' '}
                        <span style={{ color: 'var(--ink-muted)' }}>({component.unit})</span>
                      </li>
                    ))}
                  </ul>
                ),
              },
              { key: 'a', header: 'Adverse burden', align: 'right', render: (r) => num(r.adverseBurden, 4) },
              {
                key: 'res',
                header: 'Adaptive response',
                align: 'right',
                render: (r) => (r.resistance === null ? '—' : num(r.resistance, 4)),
              },
              { key: 'u', header: 'Uncertainty', align: 'right', render: (r) => num(r.uncertainty, 4) },
            ]}
          />
        </Section>
      ) : null}
    </div>
  );
}

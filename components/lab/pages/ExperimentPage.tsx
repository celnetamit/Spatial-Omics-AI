/**
 * Select the experiment and define the perturbation — §6.10, §6.11, §6.12.
 *
 * Two branches on one screen, as §6.10 describes: molecular/genetic and drug.
 * Unsupported options are *disabled with a reason* rather than hidden — a hidden
 * option teaches nothing, and "this target is not in the model's feature space"
 * teaches what the model can see.
 *
 * The drug branch shows the dose-response curve the run will use, with the
 * evidence range shaded and the extrapolated region dashed, because §5.3
 * disables extrapolation and the shape outside the range is the model's rather
 * than the evidence's.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, type PerturbationOptions } from '../../../lib/api';
import { Button, Caveat, DataTable, ResultBadge, Section } from '../../ui/Badges';
import { DoseResponseChart } from '../../viz/Charts';
import { useToast } from '../../ui/ToastContext';
import { concentration, integer, num } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

type Branch = 'molecular-genetic' | 'drug';

export default function ExperimentPage({ context }: { context: WorkspaceContext }): React.ReactElement {
  const toast = useToast();
  const [options, setOptions] = useState<PerturbationOptions | null>(null);
  const [branch, setBranch] = useState<Branch>('molecular-genetic');
  const [target, setTarget] = useState('TGFB1');
  const [operator, setOperator] = useState('knockout');
  const [magnitude, setMagnitude] = useState(0.2);
  const [drugId, setDrugId] = useState('');
  const [concentrationNm, setConcentrationNm] = useState<number | null>(null);
  const [exposureHours, setExposureHours] = useState(24);
  const [selectionMode, setSelectionMode] = useState<'cell-type' | 'region' | 'whole-tissue'>('cell-type');
  const [classes, setClasses] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!context.project) return;
    void (async () => {
      try {
        const payload = await api.perturbationOptions(context.project!.projectId);
        setOptions(payload);
        const firstDrug = payload.branches.find((entry) => entry.id === 'drug');
        if (firstDrug && 'compounds' in firstDrug) {
          const simulatable = firstDrug.compounds.find((entry) => entry.simulatable);
          if (simulatable) {
            setDrugId(simulatable.drugId);
            setConcentrationNm(simulatable.medianPotencyNm);
          }
        }
        if (payload.selection.cellTypes.length > 0) setClasses([payload.selection.cellTypes[0] as string]);
      } catch (error) {
        if (error instanceof ApiError) toast.push('error', 'Could not load perturbation options', error.message);
      }
    })();
  }, [context.project, toast]);

  const molecular = options?.branches.find((entry) => entry.id === 'molecular-genetic');
  const drug = options?.branches.find((entry) => entry.id === 'drug');
  const compound = drug && 'compounds' in drug ? drug.compounds.find((entry) => entry.drugId === drugId) : undefined;

  const availableClasses = selectionMode === 'region' ? options?.selection.regions ?? [] : options?.selection.cellTypes ?? [];

  const operators = molecular && 'operators' in molecular ? molecular.operators : [];
  const activeOperator = operators.find((entry) => entry.id === operator);

  const outOfRange = useMemo(() => {
    if (!compound?.testedRangeNm || concentrationNm === null) return false;
    return concentrationNm < compound.testedRangeNm[0] || concentrationNm > compound.testedRangeNm[1];
  }, [compound, concentrationNm]);

  if (!context.project) return <Caveat>Create or open a project first.</Caveat>;

  const define = async (): Promise<void> => {
    setSubmitting(true);
    try {
      const body: Record<string, unknown> =
        branch === 'drug'
          ? {
              branch,
              drugId,
              concentration: concentrationNm,
              concentrationUnit: 'nM',
              exposureTime: exposureHours,
              exposureTimeUnit: 'h',
              selection: { mode: selectionMode, classes },
            }
          : {
              branch,
              target,
              operator,
              magnitude: operator === 'knockout' ? 0 : magnitude,
              magnitudeSource: 'model-pack',
              selection: { mode: selectionMode, classes },
            };
      const payload = await api.createPerturbation(context.project!.projectId, body);
      context.setDefinition(payload.definition);
      await context.refreshProject();
      if (payload.blocked) {
        toast.push('warning', 'This perturbation is blocked', payload.definition.eligibility.reasons.join(' '));
      } else {
        toast.push('success', 'Perturbation defined', payload.definition.selection.description);
      }
    } catch (error) {
      if (error instanceof ApiError) {
        // A blocked definition is stored and returned with a 422 so its exact
        // parameters can be shown; anything else is a genuine refusal.
        toast.push('error', 'The perturbation could not be created', `${error.message} ${error.suggestedAction}`.trim());
      }
    } finally {
      setSubmitting(false);
    }
  };

  const definition = context.definition;
  const showsDoseResponse = branch === 'drug' && Boolean(compound?.simulatable) && Boolean(compound?.medianPotencyNm);
  const hasSidePanel = showsDoseResponse || definition !== null;

  return (
    <div className="space-y-4">
      <Section title="Select the virtual experiment" subtitle="§6.10 — the baseline state is never modified by either branch.">
        <div className="grid gap-3 sm:grid-cols-2">
          {(['molecular-genetic', 'drug'] as Branch[]).map((id) => {
            const entry = options?.branches.find((candidate) => candidate.id === id);
            const available = entry?.available ?? false;
            return (
              <button
                key={id}
                type="button"
                disabled={!available}
                onClick={() => setBranch(id)}
                title={entry?.reason ?? undefined}
                className="rounded-lg border p-4 text-left disabled:cursor-not-allowed"
                style={{
                  borderColor: branch === id ? 'var(--series-1)' : 'var(--border)',
                  background: branch === id ? 'var(--surface-raised)' : 'var(--surface-sunken)',
                  opacity: available ? 1 : 0.55,
                }}
              >
                <p className="text-[13px] font-medium" style={{ color: 'var(--ink)' }}>
                  {id === 'drug' ? 'Path B — known drug' : 'Path A — molecular / genetic'}
                </p>
                <p className="mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--ink-secondary)' }}>
                  {id === 'drug'
                    ? 'A compound with evidence-supported target, mechanism and concentration.'
                    : 'Knockout, inhibition, activation, overexpression or a mutation scenario.'}
                </p>
                {entry?.reason ? (
                  <p className="mt-1.5 text-[11px]" style={{ color: 'var(--status-warning)' }}>
                    {entry.reason}
                  </p>
                ) : null}
              </button>
            );
          })}
        </div>
      </Section>

      {/* One column until there is something to put beside the form: a form on
          half the screen with an empty half next to it reads as a missing panel. */}
      <div className={hasSidePanel ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : 'grid gap-4'}>
        <Section title="Perturbation setup" subtitle="Unsupported settings are blocked or marked exploratory before the run starts.">
          <div className="space-y-3">
            {branch === 'molecular-genetic' ? (
              <>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Target
                  </span>
                  <select
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                    style={{ color: 'var(--ink)' }}
                  >
                    {molecular && 'targets' in molecular
                      ? molecular.targets.map((entry) => (
                          <option key={entry.symbol} value={entry.symbol} disabled={!entry.supported}>
                            {entry.symbol} — {entry.pathway} ({entry.role})
                            {entry.supported ? '' : ' — not in the model feature space'}
                          </option>
                        ))
                      : null}
                  </select>
                </label>

                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Operator
                  </span>
                  <select
                    value={operator}
                    onChange={(event) => setOperator(event.target.value)}
                    className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                    style={{ color: 'var(--ink)' }}
                  >
                    {operators.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.label}
                      </option>
                    ))}
                  </select>
                </label>

                {activeOperator ? (
                  <Caveat>{activeOperator.semantics}</Caveat>
                ) : null}

                {operator !== 'knockout' ? (
                  <label className="block">
                    <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                      Magnitude {operator === 'inhibition' ? '(surviving fraction)' : '(drive, in logits)'}
                    </span>
                    <input
                      type="number"
                      step="0.1"
                      value={magnitude}
                      onChange={(event) => setMagnitude(Number.parseFloat(event.target.value))}
                      className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                      style={{ color: 'var(--ink)' }}
                    />
                  </label>
                ) : null}
              </>
            ) : (
              <>
                <label className="block">
                  <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                    Compound
                  </span>
                  <select
                    value={drugId}
                    onChange={(event) => {
                      setDrugId(event.target.value);
                      const next = drug && 'compounds' in drug ? drug.compounds.find((c) => c.drugId === event.target.value) : undefined;
                      setConcentrationNm(next?.medianPotencyNm ?? null);
                    }}
                    className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                    style={{ color: 'var(--ink)' }}
                  >
                    {drug && 'compounds' in drug
                      ? drug.compounds.map((entry) => (
                          <option key={entry.drugId} value={entry.drugId} disabled={!entry.simulatable}>
                            {entry.name} → {entry.target}
                            {entry.simulatable ? '' : ' — not simulatable'}
                          </option>
                        ))
                      : null}
                  </select>
                </label>

                {compound?.notSimulatableReason ? <Caveat tone="blocked">{compound.notSimulatableReason}</Caveat> : null}

                {compound?.simulatable ? (
                  <>
                    <label className="block">
                      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                        Concentration (nM)
                      </span>
                      <input
                        type="number"
                        step="any"
                        value={concentrationNm ?? ''}
                        onChange={(event) => setConcentrationNm(Number.parseFloat(event.target.value))}
                        className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                        style={{
                          borderColor: outOfRange ? 'var(--status-warning)' : 'var(--border)',
                          background: 'var(--surface-raised)',
                          color: 'var(--ink)',
                        }}
                      />
                      {compound.testedRangeNm ? (
                        <span className="mt-1 block text-[10.5px]" style={{ color: outOfRange ? 'var(--status-warning)' : 'var(--ink-muted)' }}>
                          Evidence range {concentration(compound.testedRangeNm[0])} – {concentration(compound.testedRangeNm[1])}
                          {outOfRange ? ' — outside it the quantitative model is disabled and the run is exploratory (§5.3).' : ''}
                        </span>
                      ) : null}
                    </label>

                    <label className="block">
                      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                        Exposure time (h)
                      </span>
                      <input
                        type="number"
                        step="1"
                        value={exposureHours}
                        onChange={(event) => setExposureHours(Number.parseFloat(event.target.value))}
                        className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                        style={{ color: 'var(--ink)' }}
                      />
                      <span className="mt-1 block text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                        Recorded on the run and shown in the report, but it does not scale the effect: no validated time model
                        ships for any compound, and fitting a rate constant with no kinetic data would be inventing kinetics
                        (§7.3).
                      </span>
                    </label>
                  </>
                ) : null}
              </>
            )}

            <label className="block">
              <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
                Target population
              </span>
              <select
                value={selectionMode}
                onChange={(event) => {
                  const mode = event.target.value as typeof selectionMode;
                  setSelectionMode(mode);
                  setClasses([]);
                }}
                className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
                style={{ color: 'var(--ink)' }}
              >
                <option value="cell-type">By cell type</option>
                <option value="region">By region</option>
                <option value="whole-tissue">Whole tissue</option>
              </select>
            </label>

            {selectionMode !== 'whole-tissue' ? (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {availableClasses.map((name) => (
                  <label key={name} className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                    <input
                      type="checkbox"
                      checked={classes.includes(name)}
                      onChange={() =>
                        setClasses((current) =>
                          current.includes(name) ? current.filter((entry) => entry !== name) : [...current, name],
                        )
                      }
                    />
                    {name}
                  </label>
                ))}
              </div>
            ) : null}

            <Button variant="primary" onClick={() => void define()} disabled={submitting}>
              {submitting ? 'Defining…' : 'Define perturbation'}
            </Button>
          </div>
        </Section>

        {hasSidePanel ? (
        <div className="space-y-4">
          {branch === 'drug' && compound?.simulatable && compound.medianPotencyNm ? (
            <Section
              title="Dose-response"
              subtitle="§7.2 — Hill/Emax on the retrieved potency. Outside the evidence range the curve is dashed."
              badge={<ResultBadge label="COMPUTED" method="perturb.dose-response" />}
            >
              <DoseResponseChart
                emax={1}
                ec50Nm={compound.medianPotencyNm}
                hill={1}
                testedRangeNm={compound.testedRangeNm}
                markedConcentrationNm={concentrationNm}
              />
              <Caveat>
                EC50 is the median of {integer(compound.measurements)} measurement(s) across{' '}
                {integer(compound.documents)} source document(s) in the frozen ChEMBL snapshot. Emax = 1 and Hill = 1 are{' '}
                <strong style={{ color: 'var(--ink)' }}>model assumptions</strong>, not measurements: a potency record says
                where a curve sits, not its slope or its floor.
              </Caveat>
            </Section>
          ) : null}

          {definition ? (
            <Section
              title="Definition"
              subtitle="Immutable once created (§6.11). Changing a parameter creates a new one rather than editing this."
              badge={
                <span
                  className="rounded-sm px-1.5 py-[1px] text-[10px] font-medium"
                  style={{
                    color:
                      definition.eligibility.decision === 'quantitative'
                        ? 'var(--status-good)'
                        : definition.eligibility.decision === 'exploratory'
                          ? 'var(--status-warning)'
                          : 'var(--status-critical)',
                    border: '1px solid currentColor',
                  }}
                >
                  {definition.eligibility.decision}
                </span>
              }
            >
              <dl className="space-y-1 text-[11.5px]" style={{ color: 'var(--ink-secondary)' }}>
                <div className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--ink-muted)' }}>Selection</dt>
                  <dd className="text-right">{definition.selection.description}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--ink-muted)' }}>Cells</dt>
                  <dd className="tnum text-right">{integer(definition.selection.resolvedIndices.length)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt style={{ color: 'var(--ink-muted)' }}>Checksum</dt>
                  <dd className="text-right font-mono text-[10.5px]">{definition.checksum.slice(0, 16)}</dd>
                </div>
              </dl>

              {definition.eligibility.reasons.length > 0 ? (
                <Caveat tone={definition.eligibility.decision === 'blocked' ? 'blocked' : 'warning'}>
                  <ul className="ml-4 list-disc">
                    {definition.eligibility.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                  {definition.eligibility.remedies.length > 0 ? (
                    <>
                      <p className="mt-1.5 font-medium" style={{ color: 'var(--ink)' }}>
                        To make it quantitative:
                      </p>
                      <ul className="ml-4 list-disc">
                        {definition.eligibility.remedies.map((remedy) => (
                          <li key={remedy}>{remedy}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </Caveat>
              ) : null}

              {definition.eligibility.decision !== 'blocked' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    disabled={Boolean(context.running)}
                    onClick={() =>
                      void context.submitRun('prediction', {
                        perturbationId: definition.id,
                        stages: 5,
                        runMechanisticReference: context.project?.mode === 'expert',
                      })
                    }
                  >
                    {context.running ? 'Running…' : 'Run the prediction'}
                  </Button>
                  {context.project?.mode === 'expert' ? (
                    <span className="self-center text-[10.5px]" style={{ color: 'var(--ink-muted)' }}>
                      Advanced mode also runs the mechanistic reference for comparison.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </Section>
          ) : null}
        </div>
        ) : null}
      </div>

      {drug && 'compounds' in drug ? (
        <Section
          title="Compound evidence"
          subtitle={
            context.meta?.drugEvidence
              ? `Frozen ${context.meta.drugEvidence.source.database} snapshot ${context.meta.drugEvidence.version}, retrieved ${context.meta.drugEvidence.retrievedAt.slice(0, 10)}. Queried at run time it would give a different answer next month with no record of which one a stored report used.`
              : undefined
          }
        >
          <DataTable
            rows={drug.compounds}
            maxHeight={320}
            columns={[
              { key: 'name', header: 'Compound', render: (r) => r.name },
              { key: 'target', header: 'Target', render: (r) => r.target },
              { key: 'class', header: 'Class', render: (r) => r.therapyClass },
              { key: 'action', header: 'Action', render: (r) => r.actionType },
              {
                key: 'potency',
                header: 'Median potency',
                align: 'right',
                render: (r) => (r.medianPotencyNm === null ? '—' : concentration(r.medianPotencyNm)),
              },
              { key: 'n', header: 'Measurements', align: 'right', render: (r) => integer(r.measurements) },
              {
                key: 'sim',
                header: 'Simulatable',
                render: (r) =>
                  r.simulatable ? (
                    <span style={{ color: 'var(--status-good)' }}>Yes</span>
                  ) : (
                    <span title={r.notSimulatableReason ?? ''} style={{ color: 'var(--status-serious)' }}>
                      No — {r.notSimulatableReason?.slice(0, 60)}…
                    </span>
                  ),
              },
            ]}
          />
          <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {context.meta?.drugEvidence?.source.citation}. Action type, therapy class and mechanism are curated from standard
            pharmacology and marked as such on every record; the potency measurements are retrieved verbatim.
          </p>
        </Section>
      ) : null}

      {options?.modelPackMissing ? <Caveat tone="warning">{options.modelPackMissing}</Caveat> : null}
      {num(0) === '' ? null : null}
    </div>
  );
}

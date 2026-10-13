/**
 * About this lab — what it claims and what it does not.
 *
 * Stated here because a research tool that overclaims teaches people to trust
 * tools that overclaim. Every entry below is something a reader could
 * reasonably assume and would be wrong about.
 */

import { Caveat, DataTable, Section } from '../../ui/Badges';
import { timestamp } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

const CLAIMS: { claim: string; reality: string }[] = [
  {
    claim: 'The bundled tissue is a real section.',
    reality:
      'It is simulated. Cells are placed by Poisson-disc rejection into a tumour core, periphery, margin and stroma; a ' +
      'curated 64-node network coupled by diffusible ligands is relaxed to steady state; counts are negative-binomial draws ' +
      'from it. Nothing computed on it is evidence about human biology.',
  },
  {
    claim: 'The propagation model was validated against real perturbation data.',
    reality:
      'It was trained and measured against the mechanistic simulator that generated the data. Every metric says how well the ' +
      'network reproduces that mechanism on sections it was not fitted to. A real spatial perturbation corpus is a freeze ' +
      'item for a research-grade release and this build does not discharge it.',
  },
  {
    claim: 'The drug parameters are fitted dose-response curves.',
    reality:
      'The EC50 is the median of real ChEMBL potency measurements, with the tested range taken from their spread. Emax = 1 ' +
      'and Hill = 1 are model assumptions: a potency record says where a curve sits, not its slope or its floor.',
  },
  {
    claim: 'Exposure time changes the predicted effect.',
    reality:
      'It does not. No validated time model ships for any compound, so the effect is reported at its plateau and the time is ' +
      'recorded rather than applied. Fitting a rate constant with no kinetic data would be inventing kinetics.',
  },
  {
    claim: 'Cells that neighbour each other are signalling to each other.',
    reality:
      'Neighbourhood enrichment and ligand-receptor scores are associations between proximity and co-expression. They are ' +
      'candidate interactions, and the difference matters: a candidate is where to look, not what happened.',
  },
  {
    claim: 'The propagation stages are hours or days.',
    reality:
      'They count rounds of intercellular signalling in the model. Nothing here is calibrated on biological time, so ' +
      'translating a stage into a duration would be a kinetic claim nothing supports.',
  },
  {
    claim: 'The top-ranked candidate is the best therapy.',
    reality:
      'There is no ranking. A composite score needs reviewer-approved weights and none exist, so the lab shows component ' +
      'metrics and a Pareto front and says there is no single winner rather than defaulting to equal weights.',
  },
  {
    claim: 'A low adverse burden means the therapy is safe.',
    reality:
      'The adverse components are signature changes in a simulated tissue. A tissue signature is not a clinical toxicity, ' +
      'and the same signature can accompany both damage and a productive immune response.',
  },
  {
    claim: 'The AI wrote the numbers.',
    reality:
      'It did not, and it cannot. Every value comes from the analysis engine. The model receives a structured evidence ' +
      'object and its output is discarded if it contains a number that is not in it. With no provider configured the lab is ' +
      'complete.',
  },
  {
    claim: 'High confidence means the prediction is right.',
    reality:
      'It means the run is inside the model’s training distribution, the ensemble members agree, and the perturbation is ' +
      'within its evidence-supported range. All three are statements about the model, not about the tissue.',
  },
];

export default function AboutPage({ context }: { context: WorkspaceContext }): React.ReactElement {
  const meta = context.meta;

  return (
    <div className="space-y-4">
      <Section title="What this lab is">
        <p className="text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          A research-use virtual experimentation platform implementing the frozen V1 workflow: spatial omics input, baseline
          tissue analysis, a controlled molecular/genetic or drug perturbation, direct response, spatial propagation, the
          predicted altered tissue, evidence-supported rescue candidates simulated one at a time, a transparent comparison,
          uncertainty, a validation experiment and a reproducible report.
        </p>
        {meta ? <Caveat tone="warning">{meta.researchBoundary}</Caveat> : null}
      </Section>

      <Section
        title="What it does not claim"
        subtitle="Every row is something a reader could reasonably assume and would be wrong about."
      >
        <div className="space-y-2.5">
          {CLAIMS.map((entry) => (
            <div key={entry.claim} className="rounded border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
              <p className="text-[12px] font-medium" style={{ color: 'var(--status-serious-text)' }}>
                ✕ {entry.claim}
              </p>
              <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
                {entry.reality}
              </p>
            </div>
          ))}
        </div>
      </Section>

      {meta ? (
        <Section title="This deployment">
          <DataTable
            rows={[
              { key: 'Version', value: `${meta.version} (${meta.commit})` },
              { key: 'Authentication', value: meta.authEnabled ? 'Hub authorisation' : 'DISABLED — every visitor is a learner' },
              { key: 'AI interpretation', value: meta.ai.available ? 'Available' : (meta.ai.unavailableReason ?? 'Unavailable') },
              {
                key: 'Propagation model',
                value: meta.modelPack ? `${meta.modelPack.modelId}@${meta.modelPack.version}` : (meta.modelPackMissing ?? 'Not installed'),
              },
              {
                key: 'Drug evidence',
                value: meta.drugEvidence
                  ? `${meta.drugEvidence.source.database} ${meta.drugEvidence.version}, ${meta.drugEvidence.compounds} compounds, retrieved ${timestamp(meta.drugEvidence.retrievedAt)}`
                  : 'Not installed',
              },
              { key: 'Resource pack', value: `v${meta.resources.version}` },
              { key: 'Research exports', value: meta.researchExports ? 'ENABLED' : 'Disabled' },
            ]}
            columns={[
              { key: 'k', header: '', render: (row) => <span style={{ color: 'var(--ink-muted)' }}>{row.key}</span> },
              { key: 'v', header: '', render: (row) => row.value },
            ]}
          />
          {meta.drugEvidence ? (
            <p className="mt-3 text-[10.5px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
              {meta.drugEvidence.source.citation} · {meta.drugEvidence.source.licence}
            </p>
          ) : null}
          <p className="mt-2 text-[10.5px] leading-relaxed" style={{ color: 'var(--ink-muted)' }}>
            {meta.resources.sources.join(' · ')}
          </p>
        </Section>
      ) : null}
    </div>
  );
}

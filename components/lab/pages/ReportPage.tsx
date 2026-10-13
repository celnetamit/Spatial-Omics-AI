/**
 * Report and export — §6.23 and §12.5.
 *
 * Seventeen sections, and a section that did not run says so rather than being
 * omitted. That distinction is the whole point of the screen: a report with
 * twelve sections looks complete, and a report with seventeen of which five say
 * "not run" tells you what you are missing.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type ReportPayload } from '../../../lib/api';
import { Button, Caveat, Section } from '../../ui/Badges';
import { EmptyState } from '../../ui/EmptyState';
import { useToast } from '../../ui/ToastContext';
import { timestamp } from '../../../lib/format';
import type { WorkspaceContext } from '../Workspace';

export default function ReportPage({ context }: { context: WorkspaceContext }): React.ReactElement {
  const toast = useToast();
  const [payload, setPayload] = useState<ReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const runId = context.predictionRunId ?? context.analysisRunId;

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    void api
      .report(runId)
      .then(setPayload)
      .catch((error: unknown) => {
        if (error instanceof ApiError) toast.push('error', 'The report could not be assembled', error.message);
      })
      .finally(() => setLoading(false));
  }, [runId, toast]);

  if (!runId) {
    return (
      <EmptyState
        title="No report to assemble yet"
        explanation="The report gathers every stage that has run — QC, baseline, perturbation, propagation, rescue — into the seventeen sections of §12.5. It fills in as the workflow progresses, starting with the analysis."
        requires={{ page: 'data' }}
        onGo={context.navigate}
      />
    );
  }
  if (loading) return <Caveat>Assembling the report…</Caveat>;
  if (!payload) return <Caveat>No report is available for this run.</Caveat>;

  const present = payload.report.sections.filter((section) => section.present).length;

  const download = (): void => {
    const blob = new Blob([JSON.stringify(payload.report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `spatial-report-${runId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <Section
        title="Report"
        subtitle={`${present} of ${payload.report.sections.length} sections have content. Generated ${timestamp(payload.report.generatedAt)}.`}
        actions={
          <div className="flex gap-2">
            <Button onClick={download}>Download JSON</Button>
            <Button onClick={() => window.print()}>Print</Button>
          </div>
        }
      >
        <Caveat>{payload.note}</Caveat>
        <p className="mt-2 text-[11.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          A section that did not run says so rather than being left out. A report with only the sections that succeeded looks
          complete; this one tells you what is missing.
        </p>
      </Section>

      <div className="space-y-2">
        {payload.report.sections.map((section) => {
          const open = expanded.has(section.number);
          return (
            <div
              key={section.number}
              className="rounded border"
              style={{
                borderColor: section.present ? 'var(--border)' : 'var(--border)',
                background: section.present ? 'var(--surface)' : 'var(--surface-sunken)',
                opacity: section.present ? 1 : 0.75,
              }}
            >
              <button
                type="button"
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(section.number)) next.delete(section.number);
                    else next.add(section.number);
                    return next;
                  })
                }
                className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left"
              >
                <span className="flex items-baseline gap-2.5">
                  <span className="tnum text-[11px]" style={{ color: 'var(--ink-muted)' }}>
                    {String(section.number).padStart(2, '0')}
                  </span>
                  <span className="text-[13px]" style={{ color: 'var(--ink)' }}>
                    {section.title}
                  </span>
                </span>
                <span className="flex items-center gap-2 text-[10.5px]">
                  {section.present ? (
                    <span style={{ color: 'var(--status-good-text)' }}>present</span>
                  ) : (
                    <span style={{ color: 'var(--ink-muted)' }}>not run</span>
                  )}
                  <span aria-hidden="true" style={{ color: 'var(--ink-muted)' }}>
                    {open ? '▾' : '▸'}
                  </span>
                </span>
              </button>
              {open ? (
                <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border)' }}>
                  {section.note ? <Caveat>{section.note}</Caveat> : null}
                  {section.present ? (
                    <pre
                      className="max-h-96 overflow-auto rounded px-2.5 py-2 font-mono text-[10.5px] leading-relaxed"
                      style={{ background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}
                    >
                      {JSON.stringify(section.content, null, 2)}
                    </pre>
                  ) : section.note ? null : (
                    <p className="text-[11.5px]" style={{ color: 'var(--ink-muted)' }}>
                      This stage has not run for this project, so the section is empty rather than estimated.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

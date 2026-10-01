/**
 * The NanoSchool Expert Reviewer Agreement & Confidentiality Undertaking.
 *
 * Rendered in full, verbatim, from `lib/governance/reviewerAgreement`. Not
 * summarised, not behind a "read the full terms" link, not paraphrased — an
 * acknowledgement is only meaningful if what was displayed is what was agreed,
 * and a paraphrase on screen with a signature in the database records consent
 * to something nobody wrote. `tests/reviewerAgreement.test.ts` asserts that
 * this file maps over the sections, the bullets and the preamble, so a future
 * change to a summary view fails the test rather than shipping.
 *
 * The acknowledgement carries the version *and* the content fingerprint, so a
 * later change to the wording is detectable rather than silently applying to
 * people who agreed to the previous one.
 */

import { useMemo, useState } from 'react';
import { api, ApiError, type SessionUser } from '../../lib/api';
import {
  AGREEMENT_CONFIRMATION, AGREEMENT_ISSUER, AGREEMENT_PREAMBLE, AGREEMENT_SECTIONS,
  AGREEMENT_SUBTITLE, AGREEMENT_TITLE, AGREEMENT_VERSION, REVIEW_ROLES,
  agreementFingerprint, missingAcknowledgementFields,
  type AcknowledgementForm, type ReviewRoleId,
} from '../../lib/governance/reviewerAgreement';
import { Button, Caveat } from '../ui/Badges';

export default function ReviewerAgreement({
  labTitle,
  domain,
  reviewBuild,
  user,
  onSigned,
  embedded = false,
}: {
  labTitle: string;
  domain: string;
  reviewBuild: string;
  user: SessionUser;
  onSigned: () => void;
  embedded?: boolean;
}): React.ReactElement {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const [form, setForm] = useState<AcknowledgementForm>({
    labTitle,
    domain,
    reviewBuild,
    reviewerName: user.displayName,
    designation: '',
    institution: '',
    email: '',
    dateAccessProvided: today,
    expectedCompletion: '',
    reviewRoles: [],
    signature: '',
    signedDate: today,
    confirmed: false,
  });
  const [missing, setMissing] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof AcknowledgementForm>(key: K, value: AcknowledgementForm[K]): void =>
    setForm((current) => ({ ...current, [key]: value }));

  const toggleRole = (id: ReviewRoleId): void =>
    setForm((current) => ({
      ...current,
      reviewRoles: current.reviewRoles.includes(id)
        ? current.reviewRoles.filter((role) => role !== id)
        : [...current.reviewRoles, id],
    }));

  const submit = async (): Promise<void> => {
    const problems = missingAcknowledgementFields(form);
    setMissing(problems);
    if (problems.length > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.signAgreement({
        ...form,
        version: AGREEMENT_VERSION,
        fingerprint: agreementFingerprint(),
      });
      onSigned();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? `${caught.message}${caught.suggestedAction ? ` ${caught.suggestedAction}` : ''}`
          : 'The acknowledgement could not be recorded.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={embedded ? '' : 'h-full overflow-y-auto'} style={{ background: 'var(--plane)' }}>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <header className="mb-6">
          <p className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--ink-muted)' }}>
            {AGREEMENT_SUBTITLE}
          </p>
          <h1 className="mt-1 text-lg font-semibold" style={{ color: 'var(--ink)' }}>
            {AGREEMENT_TITLE}
          </h1>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            Version {AGREEMENT_VERSION} · fingerprint {agreementFingerprint()}
          </p>
        </header>

        {!embedded ? (
          <Caveat tone="warning">
            This account is flagged as an expert reviewer. The lab opens once this undertaking is signed — the build it
            concerns is exactly what would otherwise be visible, so it is shown instead of the application rather than
            beside it.
          </Caveat>
        ) : null}

        <article className="mt-6 space-y-5 text-[12.5px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
          {AGREEMENT_PREAMBLE.map((paragraph) => (
            <p key={paragraph.slice(0, 40)}>{paragraph}</p>
          ))}

          {AGREEMENT_SECTIONS.map((section) => (
            <section key={section.number}>
              <h2 className="mb-1.5 text-[13px] font-semibold" style={{ color: 'var(--ink)' }}>
                {section.number}. {section.heading}
              </h2>
              <div className="space-y-2">
                {section.blocks.map((block, index) => (
                  <div key={index}>
                    {block.subheading ? (
                      <p className="font-medium" style={{ color: 'var(--ink)' }}>
                        {block.subheading}
                      </p>
                    ) : null}
                    {block.text ? <p>{block.text}</p> : null}
                    {block.bullets ? (
                      <ul className="ml-5 list-disc space-y-0.5">
                        {block.bullets.map((bullet) => (
                          <li key={bullet}>{bullet}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ))}

          <section className="rounded border px-3 py-2" style={{ borderColor: 'var(--border)' }}>
            {AGREEMENT_ISSUER.lines.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="mt-1 italic">{AGREEMENT_ISSUER.purpose}</p>
          </section>
        </article>

        <form
          className="mt-8 space-y-4 rounded-lg border p-5"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <h2 className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>
            Reviewer acknowledgement
          </h2>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Live Lab" value={form.labTitle} readOnly />
            <Field label="Domain" value={form.domain} readOnly />
            <Field label="Build under review" value={form.reviewBuild} readOnly />
            <Field label="Reviewer name" value={form.reviewerName} onChange={(v) => set('reviewerName', v)} />
            <Field label="Designation" value={form.designation} onChange={(v) => set('designation', v)} />
            <Field label="Institution / organisation" value={form.institution} onChange={(v) => set('institution', v)} />
            <Field label="Email" value={form.email} onChange={(v) => set('email', v)} type="email" />
            <Field label="Date access provided" value={form.dateAccessProvided} onChange={(v) => set('dateAccessProvided', v)} type="date" />
            <Field label="Expected completion (optional)" value={form.expectedCompletion} onChange={(v) => set('expectedCompletion', v)} type="date" />
          </div>

          <fieldset>
            <legend className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
              Review role
            </legend>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {REVIEW_ROLES.map((role) => (
                <label key={role.id} className="flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={form.reviewRoles.includes(role.id)}
                    onChange={() => toggleRole(role.id)}
                  />
                  {role.label}
                </label>
              ))}
            </div>
          </fieldset>

          <label className="flex items-start gap-2 text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
            <input
              type="checkbox"
              className="mt-0.5"
              checked={form.confirmed}
              onChange={(event) => set('confirmed', event.target.checked)}
            />
            <span>{AGREEMENT_CONFIRMATION}</span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Signature (type your name)" value={form.signature} onChange={(v) => set('signature', v)} />
            <Field label="Date" value={form.signedDate} onChange={(v) => set('signedDate', v)} type="date" />
          </div>

          {missing.length > 0 ? (
            <Caveat tone="warning">
              <p className="font-medium">Still needed:</p>
              <ul className="ml-4 list-disc">
                {missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </Caveat>
          ) : null}
          {error ? <Caveat tone="blocked">{error}</Caveat> : null}

          <Button type="submit" variant="primary" disabled={submitting}>
            {submitting ? 'Recording…' : 'Record acknowledgement'}
          </Button>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  readOnly,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  type?: string;
  readOnly?: boolean;
}): React.ReactElement {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </span>
      <input
        type={type}
        value={value}
        readOnly={readOnly}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
        className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
        style={{
          borderColor: 'var(--border)',
          background: readOnly ? 'var(--surface-sunken)' : 'var(--surface-raised)',
          color: 'var(--ink)',
        }}
      />
    </label>
  );
}

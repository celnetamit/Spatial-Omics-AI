/**
 * Feedback, proxied to the hub.
 *
 * Org-wide records live on the hub, not here, and this lab proxies rather than
 * calling from the page: the browser already holds one session, and adding a
 * cross-origin request with credentials is a class of mistake this estate has
 * made before.
 *
 * The form is the one the other labs use (name, email, designation,
 * category, optional rating, message), because those are the fields the
 * portal's feedback endpoint requires. It is shown on the Send feedback page
 * and in a dialog the sidebar opens from any screen, which records the screen
 * the reader was on.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import type { SessionUser } from '../../lib/api';
import {
  EMPTY_DRAFT,
  FEEDBACK_CATEGORIES,
  MAX_FIELD_LENGTH,
  MAX_MESSAGE_LENGTH,
  clearDraft,
  loadDraft,
  saveDraft,
  sendFeedback,
  validateFeedback,
  type FeedbackDraft,
  type FeedbackResult,
} from '../../lib/feedback';
import { Button, Section } from '../ui/Badges';
import Dialog from '../ui/Dialog';

const fieldClass = 'mt-1 w-full rounded border px-2.5 py-2 text-[12.5px]';
const fieldStyle: React.CSSProperties = { color: 'var(--ink)' };

export function FeedbackForm({
  user,
  screen,
  onDone,
}: {
  user: SessionUser | null;
  /** Where the reader was when they wrote it. */
  screen: string;
  /** Present in the dialog: closes it after a successful send. */
  onDone?: () => void;
}): React.ReactElement {
  const userId = user?.userId ?? 'anonymous';
  const ids = useId();
  const [draft, setDraft] = useState<FeedbackDraft>(
    () => loadDraft(userId) ?? { ...EMPTY_DRAFT, name: user?.displayName ?? '', email: user?.email ?? '' },
  );
  const [submitted, setSubmitted] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<FeedbackResult | null>(null);
  const errors = useMemo(() => validateFeedback(draft), [draft]);

  // Kept across a reload, so an accidental refresh does not lose a message.
  useEffect(() => saveDraft(userId, draft), [userId, draft]);

  const set = <K extends keyof FeedbackDraft>(key: K, value: FeedbackDraft[K]): void =>
    setDraft((current) => ({ ...current, [key]: value }));
  const shown = (field: keyof FeedbackDraft): string | undefined => (submitted ? errors[field] : undefined);

  const submit = async (): Promise<void> => {
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;
    setSending(true);
    const outcome = await sendFeedback(draft, screen);
    setResult(outcome);
    setSending(false);
    if (outcome.ok) clearDraft(userId);
  };

  if (result?.ok) {
    const replyDiffers = result.signedInAs && result.signedInAs.toLowerCase() !== draft.email.trim().toLowerCase();
    return (
      <div className="space-y-3 text-[12.5px]" style={{ color: 'var(--ink-secondary)' }}>
        <p style={{ color: 'var(--status-good-text)' }}>Your feedback reached the portal and was stored.</p>
        <p>{result.note}</p>
        <dl className="grid gap-1 text-[11.5px]" style={{ color: 'var(--ink-muted)' }}>
          <div>
            <dt className="inline">Reference: </dt>
            <dd className="inline font-mono">{result.id}</dd>
          </div>
          <div>
            <dt className="inline">Received: </dt>
            <dd className="inline">{new Date(result.receivedAt).toLocaleString()}</dd>
          </div>
          {result.signedInAs ? (
            <div>
              <dt className="inline">Recorded against: </dt>
              <dd className="inline">{result.signedInAs}</dd>
            </div>
          ) : null}
        </dl>
        {replyDiffers ? (
          <p className="rounded border-l-2 px-3 py-2 text-[11.5px]" style={{ borderColor: 'var(--status-warning)', background: 'var(--surface-sunken)' }}>
            You gave {draft.email.trim()} as a reply address, and this was recorded against {result.signedInAs}. Both are
            stored; a reply goes to the address you gave.
          </p>
        ) : null}
        <div className="flex gap-2 pt-1">
          {onDone ? <Button onClick={onDone}>Close</Button> : null}
          <Button
            onClick={() => {
              setResult(null);
              setSubmitted(false);
              setDraft({ ...EMPTY_DRAFT, name: draft.name, email: draft.email, designation: draft.designation });
            }}
          >
            Send another
          </Button>
        </div>
      </div>
    );
  }

  const label = (id: string, text: string): React.ReactElement => (
    <label htmlFor={`${ids}-${id}`} className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
      {text}
    </label>
  );
  const problem = (field: keyof FeedbackDraft, hint?: string): React.ReactElement | null =>
    shown(field) ? (
      <p className="mt-1 text-[11px]" style={{ color: 'var(--status-critical-text)' }}>
        {shown(field)}
      </p>
    ) : hint ? (
      <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        {hint}
      </p>
    ) : null;

  return (
    <div className="space-y-4">
      <p className="text-[12px]" style={{ color: 'var(--ink-secondary)' }}>
        This goes to the administrators of live-labs.org, who read it. No automatic reply is sent and no response time is
        promised.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          {label('name', 'Name')}
          <input id={`${ids}-name`} className={fieldClass} style={fieldStyle} maxLength={MAX_FIELD_LENGTH} value={draft.name} onChange={(event) => set('name', event.target.value)} />
          {problem('name')}
        </div>
        <div>
          {label('email', 'Email')}
          <input id={`${ids}-email`} type="email" className={fieldClass} style={fieldStyle} maxLength={MAX_FIELD_LENGTH} value={draft.email} onChange={(event) => set('email', event.target.value)} />
          {problem('email')}
        </div>
        <div>
          {label('designation', 'Designation')}
          <input
            id={`${ids}-designation`}
            className={fieldClass}
            style={fieldStyle}
            maxLength={MAX_FIELD_LENGTH}
            placeholder="e.g. Computational biologist, MSc student, Lecturer"
            value={draft.designation}
            onChange={(event) => set('designation', event.target.value)}
          />
          {problem('designation', 'Your role decides how this is read; it is what makes a report actionable.')}
        </div>
        <div>
          {label('category', 'Category')}
          <select id={`${ids}-category`} className={fieldClass} style={fieldStyle} value={draft.category} onChange={(event) => set('category', event.target.value as FeedbackDraft['category'])}>
            {FEEDBACK_CATEGORIES.map((category) => (
              <option key={category.value} value={category.value}>
                {category.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            {FEEDBACK_CATEGORIES.find((category) => category.value === draft.category)?.hint}
          </p>
        </div>
      </div>

      <div>
        <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
          Rating (optional)
        </span>
        <div className="mt-1 flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Rating out of five">
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={draft.rating === value}
              aria-label={`${value} out of 5`}
              // Choosing the current value clears it: an accidental rating can be
              // taken back, and 0 is sent as "not given", never as a score.
              onClick={() => set('rating', draft.rating === value ? 0 : value)}
              className="feedback-rating"
              data-on={draft.rating >= value || undefined}
            >
              {value}
            </button>
          ))}
          <span className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            {draft.rating === 0 ? 'Not given; nothing is recorded.' : `${draft.rating} of 5`}
          </span>
        </div>
      </div>

      <div>
        {label('message', 'Message')}
        <textarea
          id={`${ids}-message`}
          rows={6}
          className={fieldClass}
          style={fieldStyle}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="What happened, what you expected, and where in the lab you were."
          value={draft.message}
          onChange={(event) => set('message', event.target.value)}
        />
        <div className="flex justify-between gap-3">
          {problem('message') ?? <span />}
          <span className="mt-1 text-[11px]" style={{ color: 'var(--ink-muted)' }}>
            {draft.message.length} / {MAX_MESSAGE_LENGTH}
          </span>
        </div>
      </div>

      {result && !result.ok ? (
        <p role="alert" className="rounded border-l-2 px-3 py-2 text-[12px]" style={{ borderColor: 'var(--status-critical)', background: 'var(--surface-sunken)', color: 'var(--ink-secondary)' }}>
          {result.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void submit()} disabled={sending}>
          {sending ? 'Sending…' : 'Send feedback'}
        </Button>
        {onDone ? <Button onClick={onDone}>Cancel</Button> : null}
        <span className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          Sent from: {screen}
        </span>
      </div>
    </div>
  );
}

/** The form in a dialog, opened from the sidebar on any screen. */
export function FeedbackDialog({ user, screen, onClose }: { user: SessionUser | null; screen: string; onClose: () => void }): React.ReactElement {
  return (
    <Dialog title="Send feedback" onClose={onClose}>
      <FeedbackForm user={user} screen={screen} onDone={onClose} />
    </Dialog>
  );
}

/** The Send feedback page. */
export default function Feedback({ user }: { user: SessionUser | null }): React.ReactElement {
  return (
    <Section title="Send feedback" subtitle="Tell the team what is wrong, unclear or missing in this lab.">
      <FeedbackForm user={user} screen="Send feedback" />
    </Section>
  );
}

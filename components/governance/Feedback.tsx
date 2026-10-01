/**
 * Feedback, proxied to the hub.
 *
 * Org-wide records live on the hub, not here, and this lab proxies rather than
 * calling from the page: the browser already holds one session, and adding a
 * cross-origin request with credentials is a class of mistake this estate has
 * made before.
 */

import { useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button, Caveat, Section } from '../ui/Badges';

const CATEGORIES = [
  { id: 'scientific', label: 'Scientific accuracy' },
  { id: 'usability', label: 'Usability or clarity' },
  { id: 'defect', label: 'Something is broken' },
  { id: 'suggestion', label: 'Suggestion' },
] as const;

export default function Feedback({ labTitle }: { labTitle: string }): React.ReactElement {
  const [category, setCategory] = useState<string>('scientific');
  const [message, setMessage] = useState('');
  const [context, setContext] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    if (message.trim().length < 10) {
      setError('Please describe the issue in a sentence or two — a one-word report is not actionable.');
      return;
    }
    setState('sending');
    setError(null);
    try {
      await api.sendFeedback({ category, message: message.trim(), context: context.trim(), labTitle });
      setState('sent');
      setMessage('');
      setContext('');
    } catch (caught) {
      setState('idle');
      setError(
        caught instanceof ApiError
          ? `${caught.message}${caught.suggestedAction ? ` ${caught.suggestedAction}` : ''}`
          : 'The feedback could not be sent.',
      );
    }
  };

  return (
    <Section title="Send feedback" subtitle="Goes to the Live Labs portal, where it is visible to the team that maintains this lab.">
      {state === 'sent' ? (
        <Caveat>Thank you — your feedback was recorded.</Caveat>
      ) : null}
      <div className="space-y-3">
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Category
          </span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
            style={{ color: 'var(--ink)' }}
          >
            {CATEGORIES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            What happened, or what should change
          </span>
          <textarea
            value={message}
            rows={5}
            onChange={(event) => setMessage(event.target.value)}
            className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
            style={{ color: 'var(--ink)' }}
          />
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide" style={{ color: 'var(--ink-muted)' }}>
            Where in the lab (optional)
          </span>
          <input
            type="text"
            value={context}
            onChange={(event) => setContext(event.target.value)}
            placeholder="e.g. the rescue comparison, after simulating three candidates"
            className="mt-1 w-full rounded border px-2 py-1.5 text-[12px]"
            style={{ color: 'var(--ink)' }}
          />
        </label>

        {error ? <Caveat tone="warning">{error}</Caveat> : null}
        <Button variant="primary" onClick={() => void send()} disabled={state === 'sending'}>
          {state === 'sending' ? 'Sending…' : 'Send feedback'}
        </Button>
      </div>
    </Section>
  );
}

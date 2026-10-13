/**
 * A modal dialog.
 *
 * Escape and the backdrop close it; focus moves into it when it opens and
 * back to whatever opened it when it closes, so a keyboard user is not left
 * at the top of the page.
 */

import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

export default function Dialog({
  title,
  onClose,
  children,
  width = 'max-w-2xl',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
}): React.ReactElement {
  const titleId = useId();
  const panel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center overflow-y-auto px-3 py-6 sm:py-12">
      <button type="button" aria-label="Close" tabIndex={-1} onClick={onClose} className="fixed inset-0 cursor-default" style={{ background: 'rgba(0,0,0,0.55)' }} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`relative w-full ${width} rounded-xl border outline-none`}
        style={{ background: 'var(--surface)', borderColor: 'var(--border)', boxShadow: '0 24px 64px -24px rgba(0,0,0,0.5)' }}
      >
        <header className="flex items-center justify-between gap-3 border-b px-5 py-3.5" style={{ borderColor: 'var(--border)' }}>
          <h2 id={titleId} className="t-heading" style={{ color: 'var(--ink)' }}>
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="interactive inline-flex items-center justify-center rounded-md p-1.5" style={{ color: 'var(--ink-secondary)' }}>
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

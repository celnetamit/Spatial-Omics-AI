/**
 * The open project's mode, switchable in place.
 *
 * A mode changes which controls, diagnostics and exports a screen offers,
 * never the numbers (§3), so switching is safe at any point and needs no
 * re-run. Which modes this account may open is decided on the server
 * (`availableModes`, with a reason for each locked one) and checked there
 * again when the switch is made; this component only presents that decision.
 *
 * A locked mode stays focusable rather than `disabled`, so a keyboard or
 * screen-reader user can reach it and hear how to open it.
 */

import { Lock } from 'lucide-react';
import type { LabMode } from '../../lib/governance/modeLabels';
import { MODE_LABEL } from '../../lib/governance/modeLabels';

const ORDER: LabMode[] = ['basic', 'moderate', 'expert'];

export default function ModeSwitcher({
  current,
  available,
  locks,
  busy,
  onChange,
  onLocked,
}: {
  current: LabMode;
  available: LabMode[];
  locks: Partial<Record<LabMode, string>>;
  busy: boolean;
  onChange: (mode: LabMode) => void;
  onLocked: (mode: LabMode, reason: string) => void;
}): React.ReactElement {
  return (
    <div className="mode-switcher" role="group" aria-label="Mode">
      {ORDER.map((mode) => {
        const open = available.includes(mode);
        const active = mode === current;
        const reason = open ? null : (locks[mode] ?? `${MODE_LABEL[mode]} is not available on this account.`);
        return (
          <button
            key={mode}
            type="button"
            className="mode-switcher__option"
            data-active={active || undefined}
            data-locked={!open || undefined}
            aria-pressed={active}
            aria-disabled={!open || busy || undefined}
            title={reason ?? (active ? `${MODE_LABEL[mode]} (current)` : `Switch to ${MODE_LABEL[mode]}`)}
            onClick={() => {
              if (busy || active) return;
              if (!open) {
                onLocked(mode, reason as string);
                return;
              }
              onChange(mode);
            }}
          >
            {open ? null : <Lock size={11} strokeWidth={2.2} aria-hidden="true" />}
            {MODE_LABEL[mode]}
            {reason ? <span className="sr-only"> (locked: {reason})</span> : null}
          </button>
        );
      })}
    </div>
  );
}

import React from 'react';
import { appConfig } from '../../lib/config';
import { logger } from '../../lib/logger';

interface Props {
  children: React.ReactNode;
  /** Names the area, so a crash in one panel does not read as a whole-app crash. */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors and shows a recovery screen.
 *
 * The app previously had none. A malformed model response — an explanation
 * missing its hazards array, say — threw inside `.map()` during render, React
 * unmounted the whole tree, and the learner got a blank dark page with no
 * message and no way back short of reloading and losing their work. Boundaries
 * are placed per feature panel as well as at the root, so a failure in the 3D
 * viewer leaves the analysis beside it readable.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    logger.error('Render error caught by boundary', {
      label: this.props.label ?? 'root',
      message: error.message,
      componentStack: info.componentStack?.slice(0, 500),
    });
  }

  private reset = (): void => this.setState({ error: null });

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const where = this.props.label ? ` in ${this.props.label}` : '';

    return (
      <div
        role="alert"
        className="flex h-full min-h-64 w-full flex-col items-center justify-center gap-4 rounded-xl border border-red-500/30 bg-red-950/20 p-8 text-center"
      >
        <h2 className="text-xl font-bold text-red-300">Something broke{where}</h2>
        <p className="max-w-md text-sm text-slate-400">
          This part of the lab stopped unexpectedly. Your saved snippets and progress are stored
          separately and are unaffected.
        </p>

        {/* The message is shown in development only. In production it is in the
            console for an operator and out of the way of a learner, for whom a
            React stack is noise. */}
        {!appConfig.isProduction && (
          <pre className="max-w-full overflow-x-auto rounded-lg bg-slate-950 p-3 text-left text-xs text-red-300">
            {error.message}
          </pre>
        )}

        <div className="flex gap-3">
          <button
            type="button"
            onClick={this.reset}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800"
          >
            Reload the lab
          </button>
        </div>
      </div>
    );
  }
}

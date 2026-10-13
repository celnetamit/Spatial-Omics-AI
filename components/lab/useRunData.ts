/**
 * Hooks for loading a project's results and layers.
 *
 * Layers are fetched by name and cached per run. The cache matters: switching
 * between two layers on the canvas is a thing people do constantly while
 * reading a tissue, and re-fetching two thousand four hundred numbers each time
 * makes the map feel like a web page rather than an instrument.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Layer, type RunResults, type RunStatus } from '../../lib/api';

export interface RunDataState {
  results: RunResults | null;
  loading: boolean;
  error: ApiError | null;
  reload: () => void;
}

export function useRunResults(runId: string | null): RunDataState {
  const [results, setResults] = useState<RunResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!runId) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .results(runId)
      .then((value) => {
        if (!cancelled) setResults(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof ApiError ? caught : null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId, nonce]);

  return { results, loading, error, reload: useCallback(() => setNonce((n) => n + 1), []) };
}

/**
 * The cell coordinates a run's maps are drawn on.
 *
 * Only the analysis job writes an `observations` artefact, so the results of a
 * prediction or rescue run carry `observations: null`. The Predicted,
 * Propagation and Rescue maps read their own run's results, so they had no
 * coordinates and never drew.
 *
 * Those runs are built on the newest analysis (the runner takes that run's
 * handoff), and their per-cell layers follow the dataset's cell order.
 * Analysis keeps that order and only removes cells that fail QC. So the
 * analysis coordinates match a prediction layer exactly when no cell was
 * removed, which is when the counts are equal. `TissueView` checks those
 * counts and declines to draw if they differ; this function only chooses the
 * source.
 */
export function runObservations(run: RunDataState, analysis: RunDataState): RunResults['observations'] {
  return run.results?.observations ?? analysis.results?.observations ?? null;
}

export interface LayerState {
  layer: Layer | null;
  loading: boolean;
  error: string | null;
}

export function useLayer(
  runId: string | null,
  kind: string | null,
  key: string,
  stage?: number,
): LayerState {
  const [state, setState] = useState<LayerState>({ layer: null, loading: false, error: null });
  const cache = useRef(new Map<string, Layer>());

  useEffect(() => {
    if (!runId || !kind) {
      setState({ layer: null, loading: false, error: null });
      return;
    }
    const cacheKey = `${runId}|${kind}|${key}|${stage ?? ''}`;
    const cached = cache.current.get(cacheKey);
    if (cached) {
      setState({ layer: cached, loading: false, error: null });
      return;
    }

    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void api
      .layer(runId, kind, key, stage)
      .then(({ layer }) => {
        if (cancelled) return;
        // Bounded: a long session flipping through genes should not accumulate
        // a hundred arrays of a few thousand numbers each.
        if (cache.current.size > 40) cache.current.clear();
        cache.current.set(cacheKey, layer);
        setState({ layer, loading: false, error: null });
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setState({
          layer: null,
          loading: false,
          error: caught instanceof ApiError ? caught.message : 'The layer could not be loaded.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [runId, kind, key, stage]);

  return state;
}

export interface RunWatch {
  status: RunStatus | null;
  watching: boolean;
  start: (runId: string) => void;
}

/**
 * Watches a run to completion.
 *
 * The poll interval widens as the run goes on: a run that finishes in three
 * seconds should feel immediate, and one that takes four minutes should not
 * generate two hundred requests to say so.
 */
export function useRunWatch(onFinished: (status: RunStatus) => void): RunWatch {
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [watching, setWatching] = useState(false);
  const cancelled = useRef(false);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;

  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const start = useCallback((runId: string) => {
    cancelled.current = false;
    setWatching(true);
    void (async () => {
      let delay = 600;
      for (;;) {
        if (cancelled.current) return;
        try {
          const { run } = await api.run(runId);
          setStatus(run);
          if (run.status === 'complete' || run.status === 'failed' || run.status === 'cancelled') {
            setWatching(false);
            finishedRef.current(run);
            return;
          }
        } catch {
          // A transient poll failure is not a run failure; keep polling and let
          // the next answer decide.
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(4000, Math.round(delay * 1.25));
      }
    })();
  }, []);

  return { status, watching, start };
}

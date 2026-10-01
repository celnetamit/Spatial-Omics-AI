/**
 * Establishing the session, once, for the whole application.
 *
 * Two parts of the app need to know who is signed in and they mount in an order
 * nobody controls: the workspace exchanges the launch token, and the sidebar
 * decides whether to show the reviewer rows. When each asked the server
 * independently, the sidebar's question arrived first, was answered 401 because
 * the token had not been exchanged yet, and a genuine expert reviewer was shown
 * a lab with no reviewer section in it.
 *
 * So the exchange happens here and is memoised. Whichever caller is first does
 * the work; everyone else awaits the same promise and sees the same answer. The
 * launch token is spent exactly once either way.
 */

import { api, ApiError, type SessionUser } from './api';
import { consumeLaunchToken } from './launch';

export interface EstablishedSession {
  user: SessionUser | null;
  authDisabled: boolean;
  /** Null when the session was established; the reason when it was not. */
  problem: ApiError | null;
}

let pending: Promise<EstablishedSession> | null = null;

async function establish(): Promise<EstablishedSession> {
  try {
    const token = consumeLaunchToken();
    if (token) {
      const result = await api.signIn(token);
      return { user: result.user, authDisabled: result.authDisabled, problem: null };
    }
    /*
     * No token in the address bar: an existing cookie is the only way in.
     *
     * `GET /session` answers 200 with `user: null` when there is nobody signed
     * in, so a first visit is not an error. With authentication disabled for a
     * deployment, the token-free exchange below is what opens the lab.
     */
    const existing = await api.session();
    if (existing.user) {
      return { user: existing.user, authDisabled: existing.authDisabled, problem: null };
    }
    const opened = await api.signIn(null);
    return { user: opened.user, authDisabled: opened.authDisabled, problem: null };
  } catch (caught) {
    return {
      user: null,
      authDisabled: false,
      problem:
        caught instanceof ApiError
          ? caught
          : new ApiError(0, {
              code: 'INTERNAL',
              message: 'The lab could not confirm your session. Open it again from the portal.',
              requestId: 'session',
              fieldErrors: [],
              recoverable: true,
              suggestedAction: '',
            }),
    };
  }
}

export function establishSession(): Promise<EstablishedSession> {
  pending ??= establish();
  return pending;
}

/**
 * Forget the memoised answer so the next caller tries again.
 *
 * Used by the sign-in screen's retry: somebody who failed because the portal
 * was briefly unreachable must be able to try again without reloading, and a
 * cached failure would make the button do nothing.
 */
export function forgetSession(): void {
  pending = null;
}

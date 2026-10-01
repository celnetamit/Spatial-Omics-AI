/**
 * The launch token the portal puts in the address bar.
 *
 * The parameter is **`auth_token`**. That is the hub's contract, shared across
 * every Live Labs lab, and this file exists because the rewrite quietly renamed
 * it to `token`: the portal signed the learner in, redirected to
 * `https://spatial.live-labs.org/?auth_token=…`, and the lab read a parameter
 * nobody sends, found nothing, and showed "Sign in to open the lab" to someone
 * who had just done exactly that. `token` is still accepted as an alias so an
 * older launcher keeps working.
 *
 * Two things this deliberately does at module load rather than inside a
 * component:
 *
 * It takes the token out of the URL immediately. A launch token in the address
 * bar survives a copied link, a bookmark and the browser history, and it is a
 * credential.
 *
 * And it holds the token in memory rather than leaving it for whichever view
 * happens to mount. Somebody who arrives at `/?auth_token=…#/baseline` would
 * otherwise never reach the code that exchanges it, and would be signed out on
 * a page that looks like it loaded fine.
 */

const PARAMS = ['auth_token', 'token'] as const;

function take(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    let found: string | null = null;

    for (const name of PARAMS) {
      const fromQuery = url.searchParams.get(name);
      if (fromQuery) {
        found = fromQuery;
        url.searchParams.delete(name);
        break;
      }
    }

    if (!found) {
      // Some launchers append the token after the hash instead.
      const [hashPath, hashQuery] = url.hash.split('?');
      const params = new URLSearchParams(hashQuery ?? '');
      for (const name of PARAMS) {
        const fromHash = params.get(name);
        if (fromHash) {
          found = fromHash;
          params.delete(name);
          const rest = params.toString();
          url.hash = `${hashPath ?? ''}${rest ? `?${rest}` : ''}`;
          break;
        }
      }
    }

    if (found) {
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    return found;
  } catch {
    return null;
  }
}

let pending: string | null = take();

/** The launch token, once. A second caller gets null — it is spent. */
export function consumeLaunchToken(): string | null {
  const token = pending;
  pending = null;
  return token;
}

/** Whether a launch token arrived with this page load, without spending it. */
export function hadLaunchToken(): boolean {
  return pending !== null;
}

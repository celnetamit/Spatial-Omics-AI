/**
 * Client configuration, read once and frozen.
 *
 * Short on purpose. The client is a static bundle, so anything compiled into it
 * needs a rebuild to change — which makes it the wrong place for a provider
 * name, a model id, or (as an earlier build in this estate managed) an API key.
 * None of that is here. Every model call goes through the server behind the
 * §13 output gates, with a key the browser never sees.
 *
 * What is left is genuinely build-time: the version stamp, the log level, and
 * the portal links the sign-in screen needs *before* it has spoken to the
 * server. Everything else about the deployment — whether AI is available,
 * whether a model pack is installed, what the parameter registry says — the
 * client asks for at `/api/v1/meta`, so changing any of it takes a restart
 * rather than a rebuild.
 */

const env = import.meta.env;

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function resolveLogLevel(): 'debug' | 'info' | 'warn' | 'error' | 'silent' {
  const requested = env.VITE_LOG_LEVEL?.trim().toLowerCase();
  switch (requested) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
    case 'silent':
      return requested;
    default:
      return env.PROD ? 'warn' : 'debug';
  }
}

export const appConfig = Object.freeze({
  version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
  buildTime: typeof __APP_BUILD_TIME__ !== 'undefined' ? __APP_BUILD_TIME__ : 'dev',
  isProduction: Boolean(env.PROD),

  portal: Object.freeze({
    loginUrl: str(env.VITE_LAB_LOGIN_URL, 'https://live-labs.org/login'),
    homeUrl: str(env.VITE_LAB_HOME_URL, 'https://live-labs.org/labs'),
    /** Used until /api/v1/meta answers; the server's value wins. */
    labUrl: str(env.VITE_LAB_PAGE_URL, 'https://live-labs.org/dashboard/labs/spatial-ai'),
  }),

  ui: Object.freeze({
    supportEmail: str(env.VITE_SUPPORT_EMAIL, 'support@live-labs.org'),
  }),

  logLevel: resolveLogLevel(),
});

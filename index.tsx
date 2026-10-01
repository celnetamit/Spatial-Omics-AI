import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ui/ErrorBoundary';
import { appConfig } from './lib/config';
import { logger } from './lib/logger';
// Imported for its side effect: the launch token is taken out of the address
// bar on the first paint, whichever page the portal happened to land on, rather
// than waiting for the workspace to mount. A launch token is a credential and
// should not sit in a URL that can be copied or bookmarked.
import './lib/launch';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Could not find #root to mount to');

/**
 * Rejections that never reach a React error boundary — async handlers, failed
 * dynamic imports — are made visible rather than silent.
 */
window.addEventListener('unhandledrejection', (event) => {
  logger.error('Unhandled promise rejection', { reason: String(event.reason) });
});

logger.info('Spatial Omics AI Virtual LiveLab starting', {
  version: appConfig.version,
  build: appConfig.buildTime,
});

/*
 * There is no client-side authorisation gate.
 *
 * The browser exchanges the launch token once for an http-only session cookie,
 * and every disclosure decision — which modes are open, which artefacts are
 * readable, what a layer contains — is taken on the server, where the data
 * lives. A gate in the page is a gate in the one place an interested reader can
 * edit.
 */
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

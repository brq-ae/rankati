import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The brand's UI font, self-hosted (ADR 0063) — only the weights the app uses: 400 (body),
// 500 (font-medium), 600 (the title). Not a CDN.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
// Cairo is BUNDLED BUT UNUSED — groundwork for the deferred Arabic/RTL milestone (ADR 0063). It
// carries Latin and Arabic on matching metrics, so that work swaps script without re-tuning
// spacing. Nothing sets `font-family: Cairo` yet, so these @font-face rules are inert: the browser
// fetches no Cairo woff2 until something uses it (verified against the served build).
import '@fontsource/cairo/400.css';
import '@fontsource/cairo/700.css';
import App from './App';
import ErrorBoundary from './ErrorBoundary';
import { installGlobalErrorHandlers } from './error-reporter';
import './index.css';

// Catch errors outside React render (event handlers, timers, unawaited promises) and report them to the
// server log (ADR 0078). Wired before render so a crash during startup is still captured.
installGlobalErrorHandlers();

const root = document.getElementById('root');
if (!root) throw new Error('#root missing from index.html');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

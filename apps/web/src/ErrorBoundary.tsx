import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { reportError } from './error-reporter';

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string;
  showDetails: boolean;
}

/**
 * The app-wide Error Boundary (ADR 0078). A render crash below it shows a friendly card instead of a
 * blank tree, and is reported to the server log via reportError.
 *
 * The fallback is DELIBERATELY self-contained — inline styles with fixed colours and a system font, no
 * Tailwind classes, no theme tokens, no app context. The crash might be in exactly those, so the card
 * must render even when the app's own styling is what broke.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false, error: null, componentStack: '', showDetails: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Once per crash (componentDidCatch fires once; reportError also dedupes).
    reportError(error, { componentStack: errorInfo.componentStack ?? '' });
    this.setState({ componentStack: errorInfo.componentStack ?? '' });
  }

  private details(): string {
    const { error, componentStack } = this.state;
    return [error?.message ?? 'Unknown error', error?.stack ?? '', componentStack]
      .filter((s) => s.length > 0)
      .join('\n\n');
  }

  override render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    const { showDetails } = this.state;
    const detail = this.details();

    return (
      <div style={OVERLAY} role="alert">
        <div style={CARD}>
          <h1 style={TITLE}>Something went wrong</h1>
          <p style={BODY}>An unexpected error occurred. Reloading usually fixes it.</p>
          <div style={ROW}>
            <button type="button" style={PRIMARY} onClick={() => window.location.reload()}>
              Reload
            </button>
            <button
              type="button"
              style={SECONDARY}
              onClick={() => this.setState((s) => ({ showDetails: !s.showDetails }))}
            >
              {showDetails ? 'Hide details' : 'Show details'}
            </button>
          </div>
          {showDetails && (
            <div style={DETAILS}>
              <pre style={PRE}>{detail}</pre>
              <button
                type="button"
                style={SECONDARY}
                onClick={() => void navigator.clipboard?.writeText(detail).catch(() => undefined)}
              >
                Copy
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
}

// Fixed, theme-independent styling — the card must render even if the app's CSS/theme is what crashed.
const OVERLAY: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  background: '#1a102e',
  color: '#f8fafc',
  fontFamily: 'system-ui, -apple-system, sans-serif',
  zIndex: 2147483647,
};
const CARD: CSSProperties = {
  width: '100%',
  maxWidth: 480,
  background: '#2a2140',
  border: '1px solid #43395f',
  borderRadius: 16,
  padding: 24,
  boxSizing: 'border-box',
};
const TITLE: CSSProperties = { margin: '0 0 8px', fontSize: 18, fontWeight: 600 };
const BODY: CSSProperties = { margin: '0 0 16px', fontSize: 14, color: '#c9c3da', lineHeight: 1.5 };
const ROW: CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap' };
const PRIMARY: CSSProperties = {
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 500,
  color: '#1a102e',
  background: '#c4b5fd',
  border: 'none',
  borderRadius: 10,
  cursor: 'pointer',
};
const SECONDARY: CSSProperties = {
  padding: '8px 16px',
  fontSize: 14,
  fontWeight: 500,
  color: '#f8fafc',
  background: 'transparent',
  border: '1px solid #6b5e8c',
  borderRadius: 10,
  cursor: 'pointer',
};
const DETAILS: CSSProperties = { marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 };
const PRE: CSSProperties = {
  margin: 0,
  padding: 12,
  fontSize: 12,
  lineHeight: 1.4,
  color: '#e6e1f0',
  background: '#1a102e',
  border: '1px solid #43395f',
  borderRadius: 10,
  maxHeight: 240,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

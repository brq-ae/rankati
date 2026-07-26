// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ErrorBoundary from '../src/ErrorBoundary';
import { reportError } from '../src/error-reporter';

// The boundary reports via reportError — mock the module so we can assert the call (and no real POST).
vi.mock('../src/error-reporter', () => ({ reportError: vi.fn() }));

/** A component that throws during render — the thing an error boundary exists to catch. */
function Boom(): ReactNode {
  throw new Error('kaboom');
}

describe('ErrorBoundary (ADR 0078)', () => {
  const reloadMock = vi.fn();
  const writeTextMock = vi.fn(() => Promise.resolve());

  beforeEach(() => {
    vi.mocked(reportError).mockClear();
    reloadMock.mockClear();
    writeTextMock.mockClear();
    // React logs the caught error to the console during these tests — expected; keep it quiet.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    Object.defineProperty(window.location, 'reload', { configurable: true, value: reloadMock });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: writeTextMock } });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('a child that throws during render → the FALLBACK renders, not a blank tree', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText('Something went wrong')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
  });

  it('renders its children normally when there is no error', () => {
    render(
      <ErrorBoundary>
        <p>the app</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the app')).toBeDefined();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('the Reload button calls window.location.reload', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reloadMock).toHaveBeenCalledTimes(1);
  });

  it('"Show details" reveals the error + stack; Copy writes the error text to the clipboard', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    // Details are collapsed by default.
    expect(screen.queryByRole('button', { name: 'Copy' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show details' }));
    expect(screen.getByText(/kaboom/)).toBeDefined(); // the message/stack now shown

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(String(writeTextMock.mock.calls[0][0])).toContain('kaboom');
  });

  it('componentDidCatch calls reportError exactly once, with the thrown error + componentStack', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = vi.mocked(reportError).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('kaboom');
    expect(ctx).toEqual(expect.objectContaining({ componentStack: expect.any(String) }));
  });
});

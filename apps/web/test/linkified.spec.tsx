// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Linkified } from '../src/Linkified';

/**
 * The safe linkify (ADR 0095, Win 2): http(s) URLs become real anchors; everything else is plain text,
 * rendered as React text nodes — so it is XSS-safe by construction (no dangerouslySetInnerHTML).
 */
afterEach(cleanup);

describe('<Linkified>', () => {
  it('turns an http(s) URL into a new-tab, noopener anchor', () => {
    render(<Linkified text="see https://rankati.com/docs for more" />);
    const a = screen.getByRole('link', { name: 'https://rankati.com/docs' });
    expect(a.getAttribute('href')).toBe('https://rankati.com/docs');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    // the surrounding words survive as text
    expect(document.body.textContent).toBe('see https://rankati.com/docs for more');
  });

  it('leaves non-URL text plain — no anchor, no HTML injection', () => {
    render(<Linkified text={'not a link <script>alert(1)</script> ftp://x'} />);
    expect(screen.queryByRole('link')).toBeNull(); // ftp:// is NOT linked (http(s) only)
    expect(document.querySelector('script')).toBeNull(); // the <script> is inert text, never a real element
    expect(document.body.textContent).toBe('not a link <script>alert(1)</script> ftp://x');
  });

  it('handles an item that is ENTIRELY a link (one anchor, whole text)', () => {
    render(<Linkified text="https://example.com/x" />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/x');
  });

  it('leaves trailing punctuation out of the link', () => {
    render(<Linkified text="(https://example.com)." />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('https://example.com'); // no ")" or "."
    expect(document.body.textContent).toBe('(https://example.com).');
  });
});

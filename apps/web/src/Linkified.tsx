import { Fragment, type ReactNode } from 'react';

/**
 * Render free text with clickable links (ADR 0095, Win 2). XSS-safe BY CONSTRUCTION: the text is emitted as
 * React text nodes (which React escapes) and matched URLs become real `<a>` elements — this NEVER uses
 * `dangerouslySetInnerHTML`, so no markup in the text can ever execute. Only `http(s)://` URLs are linked
 * (conservative — no bare `www.`/emails), and since the match is always an http(s) scheme the `href` can
 * never be a `javascript:`/`data:` vector. Anchors open in a new tab with `rel="noopener noreferrer"` and
 * `stopPropagation` so tapping a link never also triggers the row's edit affordance.
 */
const URL_RE = /\bhttps?:\/\/[^\s<]+/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/; // punctuation that commonly abuts a pasted URL but isn't part of it

export function Linkified({ text }: { text: string }): ReactNode {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m !== null; m = URL_RE.exec(text)) {
    let url = m[0];
    const trail = url.match(TRAILING);
    if (trail) url = url.slice(0, url.length - trail[0].length); // leave trailing punctuation as plain text
    if (url.length === 0) continue;
    const start = m.index;
    if (start > last) nodes.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);
    nodes.push(
      <a
        key={key++}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className="text-primary underline underline-offset-2 break-all"
      >
        {url}
      </a>,
    );
    last = start + url.length;
  }
  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{nodes}</>;
}

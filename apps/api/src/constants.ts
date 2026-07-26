/**
 * The single local owner, until auth exists (ADRs 0026, 0039).
 *
 * Lives here rather than in @rankati/shared because the API is its only consumer — v1 has
 * no owner UI, so the web app never sends or displays it. Keeping it API-side is what
 * lets @rankati/shared stay types-only (ADR 0041).
 */
export const LOCAL_OWNER_ID = 'local';

/**
 * Every route mounts under this prefix — one rule, no exceptions (ADR 0042).
 *
 * Shared by main.ts and the smoke test: the test builds its own app and would
 * otherwise re-declare the prefix, so changing it in one place would leave the
 * other passing against a route that no longer exists.
 */
export const API_PREFIX = 'api';

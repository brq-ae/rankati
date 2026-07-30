/**
 * The app version, as a constant (ADR 0078 — the error reporter's payload uses it).
 *
 * Kept in sync with the in-app banner in App.tsx by hand: the banner stays a STRING LITERAL there
 * because `scripts/dev.sh` greps that file for it to prove the served bundle is current, so it cannot be
 * replaced by this import without breaking the FRESH check. One value, two spots, noted in both.
 */
export const APP_VERSION = '0.34.0';

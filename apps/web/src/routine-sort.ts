/**
 * The Routines climb order (ADRs 0066, 0088). The pure logic moved into `@rankati/shared` so the web and
 * the Telegram bot compute the IDENTICAL order (the `computePin`/`computeLogStats` pattern); this is just
 * the shared re-export the web imports from.
 */
export { sortRoutines, periodEnd, pacePressure } from '@rankati/shared';

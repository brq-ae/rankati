/**
 * The impact pin (ADRs 0075, 0086). The pure logic + types/defaults live in `@rankati/shared`; the pin's
 * config and snooze STATE now live server-side (fetched with the Today data, snoozed via the API), so there
 * is no client-side storage here any more — this is just the shared re-export the web imports from.
 */
export {
  computePin,
  snoozeSpanMs,
  DEFAULT_PIN_CONFIG,
  DEFAULT_SNOOZE_CONFIG,
  DEFAULT_PIN_DAYS,
} from '@rankati/shared';
export type { Impact, PinConfig, SnoozeConfig, PinDays, PinCandidate, Pin } from '@rankati/shared';

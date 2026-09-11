import { Injectable } from '@nestjs/common';
import { resolveVenue, type VenueResolved } from './maps-link-resolver';

/**
 * Thin injectable wrapper around the SSRF-hardened venue resolver (ADR 0096). It exists ONLY as a DI seam:
 * the pure resolver (maps-link-resolver.ts) is unit-tested with mocked network, and this wrapper lets the
 * wiring in TasksService be tested by overriding the provider — so the api integration suite never makes a
 * real outbound request. Runtime behaviour is exactly `resolveVenue`; there is no logic here on purpose.
 */
@Injectable()
export class MapsResolverService {
  resolve(url: string): Promise<VenueResolved> {
    return resolveVenue(url);
  }
}

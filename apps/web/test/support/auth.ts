/**
 * Shared auth stub for the App tests (ADR 0076 — the web mirror of step 3's guard fallout). Now that
 * <App/> asks GET /api/auth/status on mount, every App test's fetch stub must answer it. Each stub
 * calls this first; the default is an authenticated, set-up account, so the app renders exactly as it
 * did before the gate existed.
 */
export function authStatusResponse(
  status: { needsSetup: boolean; authenticated: boolean } = { needsSetup: false, authenticated: true },
): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () => Promise.resolve(status),
  } as unknown as Response;
}

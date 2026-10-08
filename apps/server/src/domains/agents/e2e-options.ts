/**
 * Lowest window the seam accepts. A hook turn still schedules its three evidence probes inside the window
 * (`UNKNOWN_RECOVERY_PROBES` in `hook-launch-tracker.ts`), so a sub-second value would race the probe round trip
 * instead of shortening a wait.
 */
const MIN_E2E_UNKNOWN_RECOVERY_MS = 1_000;
/**
 * Highest window the seam accepts. Anything at or above the production window is not a shortened test seam, so the
 * bound refuses it rather than silently reproducing the 2-minute wait this exists to remove.
 */
const MAX_E2E_UNKNOWN_RECOVERY_MS = 30_000;

/**
 * Resolves the shortened unknown-evidence recovery window used by focused Electron coverage of the hook turn recovery
 * path. Production launches ignore the variable even when it is present in the ambient environment.
 *
 * The production window itself is 2 minutes and is pinned, with its three-probe rule, by
 * `__tests__/hook-launch-tracker.test.ts`. The Electron workflow only has to prove that the Server, the hook bridge,
 * and the Renderer are wired to that recovery, which it proves identically against a short window, so the E2E spends
 * seconds instead of the two real minutes it used to burn on the single-worker CI pool.
 */
export function resolveE2EAgentUnknownRecoveryMs(
    environment: NodeJS.ProcessEnv,
): number | undefined {
    if (environment.CAXRI_E2E !== '1') return;
    const source = environment.CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS;
    if (source === undefined) return;
    const bounds = `CAXRI_E2E_AGENT_UNKNOWN_RECOVERY_MS must be an integer from ${MIN_E2E_UNKNOWN_RECOVERY_MS} to ${MAX_E2E_UNKNOWN_RECOVERY_MS}`;
    if (!/^[1-9]\d*$/u.test(source)) throw new Error(bounds);
    const window = Number(source);
    if (
        !Number.isSafeInteger(window) ||
        window < MIN_E2E_UNKNOWN_RECOVERY_MS ||
        window > MAX_E2E_UNKNOWN_RECOVERY_MS
    )
        throw new Error(bounds);
    return window;
}

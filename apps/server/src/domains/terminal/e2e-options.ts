const MAX_E2E_OUTPUT_FLUSH_DELAY_MS = 5_000;

/**
 * Resolves the bounded output-coalescing delay used to force deterministic delivery backpressure in focused Electron
 * coverage. Production launches ignore the variable even when it is present in the ambient environment.
 */
export function resolveE2ETerminalOutputFlushDelay(
    environment: NodeJS.ProcessEnv,
): number | undefined {
    if (environment.CAXRI_E2E !== '1') return;
    const source = environment.CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS;
    if (source === undefined) return;
    if (!/^[1-9]\d*$/u.test(source))
        throw new Error(
            `CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS must be an integer from 1 to ${MAX_E2E_OUTPUT_FLUSH_DELAY_MS}`,
        );
    const delay = Number(source);
    if (!Number.isSafeInteger(delay) || delay > MAX_E2E_OUTPUT_FLUSH_DELAY_MS)
        throw new Error(
            `CAXRI_E2E_TERMINAL_OUTPUT_FLUSH_DELAY_MS must be an integer from 1 to ${MAX_E2E_OUTPUT_FLUSH_DELAY_MS}`,
        );
    return delay;
}

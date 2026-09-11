/**
 * Stand-in for the Renderer's `caxri` bridge so the rule fixtures stay self-contained. The rule matches the
 * `caxri.request('<method>')` call shape syntactically, so the stub is enough to exercise it.
 */
export const caxri = {
    request: (method: string, parameters?: Record<string, unknown>): Promise<unknown> =>
        Promise.resolve({ method, parameters }),
    requestWithSignal: (
        method: string,
        signal: AbortSignal,
        parameters?: Record<string, unknown>,
    ): Promise<unknown> => Promise.resolve({ method, parameters, aborted: signal.aborted }),
};

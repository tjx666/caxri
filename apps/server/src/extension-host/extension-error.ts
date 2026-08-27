/**
 * Normalizes loader and provider failures into the stable Extension Host error taxonomy.
 */
export function extensionErrorShape(error: unknown): { code: string; message: string } {
    const rawCode =
        typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : undefined;
    const rawMessage = error instanceof Error ? error.message : String(error);
    const rawStableCode =
        [
            'ERR_PACKAGE_PATH_NOT_EXPORTED',
            'ERR_REQUIRE_ESM',
            'ERR_MODULE_NOT_FOUND',
            'MODULE_NOT_FOUND',
        ].includes(rawCode ?? '') && rawMessage.includes('caxri')
            ? 'COMMONJS_API_UNSUPPORTED'
            : (rawCode ?? 'ACTIVATION_FAILED');
    /**
     * Server Core treats oversized child messages as a compromised Extension Host. Normalize errors here so one noisy
     * provider cannot turn its local failure into a shared-host crash.
     */
    const code = rawStableCode.slice(0, 100) || 'ACTIVATION_FAILED';
    const message = rawMessage.slice(0, 2_048) || 'Extension failed without an error message';
    return { code, message };
}

const nonExpiringRuntimeMethods = new Set(['files.copy', 'files.write']);

/**
 * Copy and save lack a durable completion journal, so every transport must wait for the
 * authoritative Runtime result instead of reporting a timeout while disk mutation continues.
 */
export function isNonExpiringRuntimeMethod(method: string): boolean {
    return nonExpiringRuntimeMethods.has(method);
}

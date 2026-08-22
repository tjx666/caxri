const forbiddenDesktopImports = [
    '/src/host/',
    '/src/main/',
    '/src/preload/',
    '/src/renderer/',
    '/src/runtime/',
    '@caxri/protocol',
] as const;

/**
 * Ensures a bundled extension still crosses the public ESM API boundary after Vite transforms it.
 */
export function assertExtensionBundleContract(source: string, extensionId: string): void {
    if (!/from\s+["']caxri["']/.test(source))
        throw new Error(`${extensionId} bundle does not retain an external caxri import`);
    if (source.includes('CAXRI_API_OUTSIDE_EXTENSION_HOST'))
        throw new Error(`${extensionId} bundle contains the outside-host API stub`);
    if (/(?:from\s*|import\s*|import\(\s*|require\(\s*)["']electron(?:\/[^"']*)?["']/.test(source))
        throw new Error(`${extensionId} bundle imports forbidden Desktop internals: electron`);
    const forbidden = forbiddenDesktopImports.find((specifier) => source.includes(specifier));
    if (forbidden)
        throw new Error(`${extensionId} bundle imports forbidden Desktop internals: ${forbidden}`);
}

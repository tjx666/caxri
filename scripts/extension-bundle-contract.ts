import { builtinModules } from 'node:module';

const forbiddenDesktopImports = [
    '/src/host/',
    '/src/main/',
    '/src/preload/',
    '/src/renderer/',
    '/src/runtime/',
    '@caxri/protocol',
] as const;

const nodeBuiltinModules = new Set(
    builtinModules.map((specifier) =>
        specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier,
    ),
);

const staticImportPattern = /\b(?:from|import|require)\s*(?:\(\s*)?["']([^"']+)["']/g;

function isNodeBuiltinSpecifier(specifier: string): boolean {
    return specifier.startsWith('node:') || nodeBuiltinModules.has(specifier);
}

function assertNoDesktopInternalImports(source: string, extensionId: string): void {
    const imports = source
        .matchAll(staticImportPattern)
        .map((match) => match[1])
        .toArray();
    const forbiddenSpecifier = imports.find(
        (specifier) =>
            specifier !== 'caxri' &&
            (isNodeBuiltinSpecifier(specifier) ||
                specifier.startsWith('electron') ||
                specifier.startsWith('@caxri/') ||
                specifier.startsWith('@/') ||
                specifier.startsWith('@shared/') ||
                forbiddenDesktopImports.some((fragment) => specifier.includes(fragment))),
    );
    if (forbiddenSpecifier)
        throw new Error(
            `${extensionId} product bundle imports a forbidden Desktop module: ${forbiddenSpecifier}`,
        );

    const nonPublicSpecifier = imports.find((specifier) => specifier !== 'caxri');
    if (nonPublicSpecifier)
        throw new Error(
            `${extensionId} product bundle imports a non-public module: ${nonPublicSpecifier}`,
        );
}

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

/**
 * Applies the stricter boundary required by production product extensions.
 *
 * Production extension code executes in the Extension Host and may only consume the public `caxri` API. Keeping this
 * check on the generated bundle catches accidental Node/Electron or Desktop-internal imports even when the source file
 * itself is hidden behind a new helper or a transitive extension-local import.
 */
export function assertProductExtensionBundleContract(source: string, extensionId: string): void {
    assertExtensionBundleContract(source, extensionId);
    assertNoDesktopInternalImports(source, extensionId);
}

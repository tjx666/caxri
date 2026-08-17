/**
 * Loads every vscode-icons SVG vendored by `@yutengjing/vscode-icons` as a build-time URL, keyed by the icon filename
 * the package returns (e.g. `file_type_typescript.svg`). `import.meta.glob` with the `?url` query keeps each SVG as a
 * separate emitted asset instead of inlining it, matching the previous `@lobehub/assets-fileicon` imports' `?no-inline`
 * behavior.
 */
const iconUrlModules = import.meta.glob<string>(
    '../../../../../node_modules/@yutengjing/vscode-icons/assets/icons/*.svg',
    { eager: true, query: '?url', import: 'default' },
);

const iconUrlsByFilename = new Map<string, string>(
    Object.entries(iconUrlModules).map(([path, url]) => [path.split('/').at(-1) ?? path, url]),
);

const warnedFilenames = new Set<string>();

/**
 * Resolves a vscode-icons filename (as returned by `getIconForFile`/`getIconForFolder`) to the build-time asset URL for
 * that SVG. Fails closed to the default file icon: the lookup tables and the SVG assets both come from
 * `@yutengjing/vscode-icons`, so a mismatch is an upstream packaging bug, and throwing here would let a single
 * unresolvable filename during a file-tree render take down the whole Renderer through the top-level ErrorBoundary.
 */
export function getVscodeIconUrl(filename: string): string {
    const url = iconUrlsByFilename.get(filename);
    if (url) return url;
    if (!warnedFilenames.has(filename)) {
        warnedFilenames.add(filename);
        console.warn(`Missing vscode-icons asset for "${filename}"; falling back to default_file`);
    }
    const fallback = iconUrlsByFilename.get('default_file.svg');
    if (!fallback) throw new Error('vscode-icons assets are missing default_file.svg');
    return fallback;
}

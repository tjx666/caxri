/**
 * Resolves a vscode-icons filename (as returned by `getIconForFile`/`getIconForFolder`) to its asset URL. The SVGs are
 * NOT bundled through `import.meta.glob` (Vite ignores glob patterns that reach into `node_modules` in production
 * builds), but shipped verbatim by the renderer `publicDir` copy in `electron.vite.config.ts`
 * (`@yutengjing/vscode-icons/assets` → `out/renderer/icons/*.svg`, served at `/icons/*` by the dev server). The
 * relative URL resolves against `index.html` in both the dev server and the packaged `file://` renderer. Lookup
 * filenames and the shipped assets come from the same upstream package, so a returned filename always has a matching
 * file.
 */
export function getVscodeIconUrl(filename: string): string {
    return `./icons/${filename}`;
}

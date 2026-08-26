/**
 * Electron-vite (Vite) supports importing any file's contents as a raw string via the `?raw` query suffix.
 * `tsconfig.node.json` scopes `types` to `["node", "electron"]` (no `vite/client`), so this ambient declaration is
 * needed for `sqlite.ts` to import the drizzle-kit-generated migration SQL as a bundled string instead of reading it
 * from disk at runtime.
 */
declare module '*.sql?raw' {
    const content: string;
    export default content;
}

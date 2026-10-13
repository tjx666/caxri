/**
 * Build-time constants injected via `define` in electron.vite.config.ts (main build target). They are replaced with
 * literal values at bundle time, so referencing them directly is safe in a real electron-vite build. Guard with
 * `typeof` before use so code executed outside that build (for example a future direct import from a test) degrades
 * instead of throwing a ReferenceError.
 */
declare global {
    const __CAXRI_VERSION__: string;
    const __CAXRI_COMMIT__: string;
    const __CAXRI_SOURCE_MAP_FLAVOR__: string;
}

export {};

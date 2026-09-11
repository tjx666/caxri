/**
 * Device-local Renderer persistence. Only presentation state that is never written through to the Server belongs here
 * (chrome layout, menu ordering); Session and Project state stays authoritative on the Server.
 *
 * Every access is failure-tolerant on purpose: the module is imported during store construction at module-load time,
 * and `localStorage` is absent under Vitest's Node environment and can throw when storage is full or disabled.
 */

function isBrowserStorageAvailable(): boolean {
    // DOM lib types declare `localStorage` as always present, but this module also runs under Vitest's Node
    // environment, where the global is genuinely absent.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    return typeof window !== 'undefined' && globalThis.localStorage !== undefined;
}

/**
 * Returns the raw entry, or `undefined` when storage is unavailable, the key is unset, or the read throws.
 */
export function readLocalStorageEntry(key: string): string | undefined {
    if (!isBrowserStorageAvailable()) return undefined;
    try {
        return localStorage.getItem(key) ?? undefined;
    } catch {
        return undefined;
    }
}

/**
 * Parses a JSON entry into `unknown`, leaving validation to the caller. A missing or corrupt entry yields `undefined`
 * so the caller falls back to its defaults instead of throwing during module load.
 */
export function readLocalStorageJson(key: string): unknown {
    const raw = readLocalStorageEntry(key);
    if (raw === undefined) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

/**
 * Best-effort write. A full or disabled store (private mode) silently keeps the value in memory for this session only.
 */
export function writeLocalStorageJson(key: string, value: unknown): void {
    if (!isBrowserStorageAvailable()) return;
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage full or disabled (private mode); the value still works for this session.
    }
}

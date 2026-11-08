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
function readLocalStorageEntry(key: string): string | undefined {
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
function readLocalStorageJson(key: string): unknown {
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
function writeLocalStorageJson(key: string, value: unknown): void {
    if (!isBrowserStorageAvailable()) return;
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        // Storage full or disabled (private mode); the value still works for this session.
    }
}

function removeLocalStorageEntry(key: string): void {
    if (!isBrowserStorageAvailable()) return;
    try {
        localStorage.removeItem(key);
    } catch {
        // Storage disabled; nothing to remove.
    }
}

/**
 * Removes the entries whose key starts with one of `prefixes`. For retiring keys a previous build wrote and nothing
 * reads any more; a live store never needs it.
 */
export function removeLocalStorageEntriesByPrefix(prefixes: readonly string[]): void {
    if (!isBrowserStorageAvailable()) return;
    try {
        for (const key of Object.keys(localStorage))
            if (prefixes.some((prefix) => key.startsWith(prefix))) localStorage.removeItem(key);
    } catch {
        // Storage can be unavailable (a locked profile); the leftovers are harmless.
    }
}

/**
 * The only way Renderer code persists view state to `localStorage` (docs/client-local-data.md); the raw read and write
 * helpers above stay private to this module on purpose.
 *
 * One `localStorage` entry that every Workbench window of the profile shares (the main window, torn-off Session
 * windows, and SSH Host windows all use one partition). A store that reads its entry once at startup and later writes
 * its whole in-memory value back silently reverts what another window wrote meanwhile, so state that belongs to the
 * user rather than to one window goes through this instead of {@link writeLocalStorageJson}:
 *
 * - {@link SharedLocalState.patch} re-reads the stored object at write time and changes only the named fields, so two
 *   windows that each changed a different key both survive.
 * - {@link SharedLocalState.subscribe} delivers another window's write so the in-memory copy follows. The browser fires
 *   `storage` only in the OTHER documents of the profile, never in the writer, so applying a delivered value to memory
 *   cannot loop back into a write as long as the listener updates state without persisting it.
 *
 * A write that must not follow other windows (a genuinely per-window preference) still uses this type for its
 * `patch`/`write` but never subscribes, and says so where it is declared.
 */
export interface SharedLocalState<T> {
    /**
     * The currently stored value, parsed. A missing or corrupt entry yields whatever `parse` makes of `undefined`.
     */
    read: () => T;
    /**
     * Replaces the whole entry; `undefined` removes it. Only for a scalar or an entry that is deliberately one value;
     * keyed records use {@link SharedLocalState.patch}.
     */
    write: (raw: unknown) => void;
    /**
     * Merges `fields` into the stored object at call time; a field set to `undefined` is removed. Returns the merged
     * value, which includes fields other windows wrote.
     */
    patch: (fields: Readonly<Record<string, unknown>>) => T;
    /**
     * Calls `listener` with the parsed value after another window changed (or cleared) the entry. Returns the
     * unsubscribe function.
     */
    subscribe: (listener: (value: T) => void) => () => void;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Binds `key` to a {@link SharedLocalState}. Every access is failure-tolerant like the rest of this module.
 */
export function createSharedLocalState<T>(
    key: string,
    parse: (raw: unknown) => T,
): SharedLocalState<T> {
    return {
        read: () => parse(readLocalStorageJson(key)),
        write: (raw) => {
            if (raw !== undefined) writeLocalStorageJson(key, raw);
            else removeLocalStorageEntry(key);
        },
        patch: (fields) => {
            const stored = readLocalStorageJson(key);
            const merged: Record<string, unknown> = isPlainRecord(stored) ? { ...stored } : {};
            for (const [field, value] of Object.entries(fields)) {
                if (value === undefined) delete merged[field];
                else merged[field] = value;
            }
            writeLocalStorageJson(key, merged);
            return parse(merged);
        },
        subscribe: (listener) => {
            if (!isBrowserStorageAvailable()) return () => {};
            const onStorage = (event: StorageEvent): void => {
                // `key === null` is `localStorage.clear()`.
                if (event.storageArea !== localStorage) return;
                if (event.key !== null && event.key !== key) return;
                listener(parse(readLocalStorageJson(key)));
            };
            addEventListener('storage', onStorage);
            return () => removeEventListener('storage', onStorage);
        },
    };
}

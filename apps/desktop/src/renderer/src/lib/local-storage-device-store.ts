import type { DeviceStoreListing } from '@caxri/protocol';

interface StoredEntry {
    modifiedAt: number;
    text: string;
}

/**
 * A `createDeviceStore` backend over this Renderer profile's `localStorage`, one key per entry under `prefix`. Every
 * call finishes on the caller's tick, which is what keeps a write flushed from `pagehide` on disk: an IndexedDB
 * transaction started there can be dropped when the window reloads or quits before it commits. `localStorage` is shared
 * by every window of the profile and bounded to a few MB, so only small text belongs here; images stay in IndexedDB
 * (`indexedDatabaseDeviceStoreBackend`).
 */
export function localStorageDeviceStoreBackend(prefix: string) {
    const keyOf = (name: string): string => `${prefix}${name}`;
    const parse = (raw: string | null): StoredEntry | undefined => {
        if (raw === null) return undefined;
        try {
            const entry = JSON.parse(raw) as Partial<StoredEntry>;
            return typeof entry.text === 'string' && typeof entry.modifiedAt === 'number'
                ? { modifiedAt: entry.modifiedAt, text: entry.text }
                : undefined;
        } catch {
            return undefined;
        }
    };
    const names = (): string[] => {
        const found: string[] = [];
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (key?.startsWith(prefix)) found.push(key.slice(prefix.length));
        }
        return found;
    };
    return {
        clear: (): void => {
            for (const name of names()) localStorage.removeItem(keyOf(name));
        },
        count: (): number => names().length,
        list: (): DeviceStoreListing =>
            names().flatMap((name) => {
                const entry = parse(localStorage.getItem(keyOf(name)));
                return entry
                    ? [{ modifiedAt: entry.modifiedAt, name, size: entry.text.length }]
                    : [];
            }),
        read: (name: string): string | null =>
            parse(localStorage.getItem(keyOf(name)))?.text ?? null,
        remove: (name: string): void => {
            localStorage.removeItem(keyOf(name));
        },
        write: (name: string, text: string): void => {
            localStorage.setItem(
                keyOf(name),
                JSON.stringify({ modifiedAt: Date.now(), text } satisfies StoredEntry),
            );
        },
    };
}

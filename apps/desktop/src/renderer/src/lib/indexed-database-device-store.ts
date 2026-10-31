import type { DeviceStoreBackend } from '@caxri/protocol';

const STORE_NAME = 'entries';

interface StoredEntry {
    name: string;
    text: string;
    modifiedAt: number;
}

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
    return new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error ?? new Error('IDB failed')));
    });
}

/**
 * A `createDeviceStore` backend over one IndexedDB database of this Renderer profile. The database opens on first use,
 * so loading a module never touches storage, and each write resolves once its transaction committed.
 */
export function indexedDatabaseDeviceStoreBackend(databaseName: string): DeviceStoreBackend {
    let database: Promise<IDBDatabase> | undefined;
    const objectStore = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
        database ??= (() => {
            const request = indexedDB.open(databaseName, 1);
            request.addEventListener('upgradeneeded', () => {
                request.result.createObjectStore(STORE_NAME, { keyPath: 'name' });
            });
            return requestResult(request);
        })();
        return (await database).transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    };
    const commit = async (
        mode: IDBTransactionMode,
        change: (store: IDBObjectStore) => void,
    ): Promise<void> => {
        const store = await objectStore(mode);
        await new Promise<void>((resolve, reject) => {
            store.transaction.addEventListener('complete', () => resolve());
            store.transaction.addEventListener('abort', () =>
                reject(store.transaction.error ?? new Error('IDB transaction aborted')),
            );
            change(store);
        });
    };
    return {
        clear: () => commit('readwrite', (store) => store.clear()),
        count: async () => requestResult((await objectStore('readonly')).count()),
        list: async () => {
            const entries = (await requestResult(
                (await objectStore('readonly')).getAll(),
            )) as StoredEntry[];
            return entries.map(({ modifiedAt, name, text }) => ({
                modifiedAt,
                name,
                size: text.length,
            }));
        },
        read: async (name) => {
            const entry = (await requestResult((await objectStore('readonly')).get(name))) as
                StoredEntry | undefined;
            return entry?.text ?? null;
        },
        remove: (name) => commit('readwrite', (store) => store.delete(name)),
        write: (name, text) =>
            commit('readwrite', (store) =>
                store.put({ name, text, modifiedAt: Date.now() } satisfies StoredEntry),
            ),
    };
}

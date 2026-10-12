import type { AgentChatImageInput, EnvironmentState } from '@caxri/protocol';
import { agentChatImageInputSchema } from '@caxri/protocol';

/**
 * Unsent composer images per Chat, kept across a restart the way the text draft is. They cannot share the text's
 * `localStorage` entry: one Chat may hold 20 MB of images, about 27 MB once base64-encoded, far past that quota. They
 * live in this device's IndexedDB instead, never in Server Core, since they are this device's unsent input rather than
 * Session state. The store is bounded by {@link MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS} across all Chats and
 * drops the Chats whose images were left alone longest first; it never touches the text drafts.
 */

/**
 * One attachment as stored; the composer's `AgentChatAttachment` has the same shape, thumbnail included, so a restored
 * chip shows at once without decoding the image again.
 */
export interface PersistedAgentChatAttachment {
    id: string;
    image: AgentChatImageInput;
    name?: string;
    isResized?: boolean;
}

export interface PersistedAgentChatAttachmentRecord {
    terminalId: string;
    attachments: readonly PersistedAgentChatAttachment[];
    /**
     * When the Chat's images last changed, which decides what is dropped first.
     */
    updatedAt: number;
}

/**
 * Where the records live: IndexedDB in the Renderer (`indexedDatabaseAgentChatAttachmentBackend`), a map in tests.
 */
export interface AgentChatAttachmentBackend {
    readAll: () => Promise<unknown[]>;
    put: (record: PersistedAgentChatAttachmentRecord) => Promise<void>;
    delete: (terminalId: string) => Promise<void>;
}

/**
 * Encoded characters (image data plus thumbnail) kept across all Chats: a few Chats at the per-message image limit.
 */
const MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS = 128 * 1024 * 1024;

/**
 * Reads a stored attachment list. Anything malformed is dropped attachment by attachment rather than trusted: the store
 * is written only by this module, but a corrupt profile must not break the composer or send a broken image.
 */
export function parsePersistedAgentChatAttachments(value: unknown): PersistedAgentChatAttachment[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { id, image, isResized, name } = entry as Record<string, unknown>;
        const parsed = agentChatImageInputSchema.safeParse(image);
        if (typeof id !== 'string' || !id || !parsed.success) return [];
        return [
            {
                id,
                image: parsed.data,
                ...(typeof name === 'string' && { name }),
                ...(isResized === true && { isResized }),
            },
        ];
    });
}

export function agentChatAttachmentCharacters(
    attachments: readonly PersistedAgentChatAttachment[],
): number {
    return attachments.reduce(
        (total, { image }) => total + image.data.length + image.thumbnail.length,
        0,
    );
}

/**
 * The Chats to drop, least recently changed first, so the rest fit in `limit` characters.
 */
export function agentChatAttachmentEvictions(
    sizes: ReadonlyMap<string, { characters: number; updatedAt: number }>,
    limit: number,
): string[] {
    let total = sizes.values().reduce((sum, { characters }) => sum + characters, 0);
    const evicted: string[] = [];
    const oldestFirst = sizes
        .entries()
        .toArray()
        .toSorted(([, left], [, right]) => left.updatedAt - right.updatedAt);
    for (const [terminalId, { characters }] of oldestFirst) {
        if (total <= limit) break;
        evicted.push(terminalId);
        total -= characters;
    }
    return evicted;
}

function parseRecord(
    value: unknown,
): { terminalId: string; attachments: unknown; updatedAt: number } | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const { attachments, terminalId, updatedAt } = value as Record<string, unknown>;
    if (typeof terminalId !== 'string' || !terminalId) return undefined;
    return {
        terminalId,
        attachments,
        updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0,
    };
}

/**
 * Mirrors the composer's in-memory attachments into `backend`. Writes are queued in order and their failures dropped:
 * losing a persisted image only costs a re-paste after a restart, and must never fail the composer.
 *
 * `hydrate` reads what an earlier run left, once, at startup. A Chat whose images changed in this run before it
 * finished (`save`) keeps this run's images, and a Chat the Workbench already reported gone (`retain`) is deleted
 * rather than restored.
 */
export function createAgentChatAttachmentPersistence({
    backend,
    limit = MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS,
    now = Date.now,
}: {
    backend: AgentChatAttachmentBackend;
    limit?: number;
    now?: () => number;
}) {
    const sizes = new Map<string, { characters: number; updatedAt: number }>();
    const changedBeforeHydration = new Set<string>();
    const state: { isHydrated: boolean; queue: Promise<void>; retained?: ReadonlySet<string> } = {
        isHydrated: false,
        queue: Promise.resolve(),
    };
    const enqueue = (task: () => Promise<void>): void => {
        const previous = state.queue;
        state.queue = (async () => {
            await previous;
            try {
                await task();
            } catch {
                // Dropped on purpose; see above.
            }
        })();
    };
    const remove = (terminalId: string): void => {
        sizes.delete(terminalId);
        enqueue(() => backend.delete(terminalId));
    };
    const evict = (): string[] => {
        const evicted = agentChatAttachmentEvictions(sizes, limit);
        for (const terminalId of evicted) remove(terminalId);
        return evicted;
    };
    return {
        async hydrate(): Promise<Map<string, PersistedAgentChatAttachment[]>> {
            const restored = new Map<string, PersistedAgentChatAttachment[]>();
            let records: unknown[] = [];
            try {
                records = await backend.readAll();
            } catch {
                // An unreadable store restores nothing; the composer starts empty as before.
            }
            for (const value of records) {
                const record = parseRecord(value);
                if (!record || changedBeforeHydration.has(record.terminalId)) continue;
                const attachments = parsePersistedAgentChatAttachments(record.attachments);
                if (attachments.length === 0 || state.retained?.has(record.terminalId) === false) {
                    remove(record.terminalId);
                    continue;
                }
                sizes.set(record.terminalId, {
                    characters: agentChatAttachmentCharacters(attachments),
                    updatedAt: record.updatedAt,
                });
                restored.set(record.terminalId, attachments);
            }
            for (const terminalId of evict()) restored.delete(terminalId);
            state.isHydrated = true;
            changedBeforeHydration.clear();
            return restored;
        },
        save(terminalId: string, attachments: readonly PersistedAgentChatAttachment[]): void {
            if (!state.isHydrated) changedBeforeHydration.add(terminalId);
            if (attachments.length === 0) {
                remove(terminalId);
                return;
            }
            const record = { terminalId, attachments: [...attachments], updatedAt: now() };
            sizes.set(terminalId, {
                characters: agentChatAttachmentCharacters(attachments),
                updatedAt: record.updatedAt,
            });
            enqueue(() => backend.put(record));
            evict();
        },
        /**
         * Deletes the images of every Chat outside `chatTerminalIds`, including ones `hydrate` has yet to read.
         */
        retain(chatTerminalIds: ReadonlySet<string>): void {
            state.retained = chatTerminalIds;
            for (const terminalId of sizes.keys())
                if (!chatTerminalIds.has(terminalId)) remove(terminalId);
        },
        /**
         * Settles once every queued write reached the backend.
         */
        flushed: (): Promise<void> => state.queue,
    };
}

const DATABASE_NAME = 'caxri-agent-chat';

/**
 * The IndexedDB database for one environment's Chats. Every Workbench window (local or SSH Host) loads the same
 * `file://` origin and so shares IndexedDB, while each window retains only its own environment's Chat Terminals; one
 * shared database would let a window delete every other environment's unsent images as unretained. An SSH Host window
 * is keyed by its destination, which names one window since aliases of one account reuse it. A window whose environment
 * is not known yet (the Agent Commander window never reads it, and only ever shows local Chats) uses the local
 * database: Main answers the environment before the Server attaches, so a Workbench window knows it before any Chat
 * composer exists.
 */
export function agentChatAttachmentDatabaseName(environment: EnvironmentState | undefined): string {
    return environment?.kind === 'ssh'
        ? `${DATABASE_NAME}:ssh:${environment.destination}`
        : DATABASE_NAME;
}
const STORE_NAME = 'composer-attachments';

function requestResult<Result>(request: IDBRequest<Result>): Promise<Result> {
    return new Promise((resolve, reject) => {
        request.addEventListener('success', () => resolve(request.result));
        request.addEventListener('error', () => reject(request.error ?? new Error('IDB failed')));
    });
}

/**
 * The Renderer's IndexedDB store, opened on first use so loading the module never touches storage; `databaseName` is
 * read at that moment (see `agentChatAttachmentDatabaseName`). A write resolves once its transaction committed.
 */
export function indexedDatabaseAgentChatAttachmentBackend(
    databaseName: () => string,
): AgentChatAttachmentBackend {
    const opened: { database?: Promise<IDBDatabase> } = {};
    const objectStore = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
        opened.database ??= (() => {
            const request = indexedDB.open(databaseName(), 1);
            request.addEventListener('upgradeneeded', () => {
                request.result.createObjectStore(STORE_NAME, { keyPath: 'terminalId' });
            });
            return requestResult(request);
        })();
        return (await opened.database).transaction(STORE_NAME, mode).objectStore(STORE_NAME);
    };
    const commit = (store: IDBObjectStore): Promise<void> =>
        new Promise((resolve, reject) => {
            store.transaction.addEventListener('complete', () => resolve());
            store.transaction.addEventListener('abort', () =>
                reject(store.transaction.error ?? new Error('IDB transaction aborted')),
            );
        });
    return {
        readAll: async () => requestResult((await objectStore('readonly')).getAll()),
        put: async (record) => {
            const store = await objectStore('readwrite');
            store.put(record);
            await commit(store);
        },
        delete: async (terminalId) => {
            const store = await objectStore('readwrite');
            store.delete(terminalId);
            await commit(store);
        },
    };
}

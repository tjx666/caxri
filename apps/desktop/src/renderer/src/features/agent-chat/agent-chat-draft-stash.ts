import type {
    AgentChatAttachmentBackend,
    PersistedAgentChatAttachmentRecord,
} from './agent-chat-attachment-persistence';
import {
    agentChatAttachmentCharacters,
    currentAgentChatComposerScope,
    indexedDatabaseAgentChatAttachmentBackend,
    MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS,
    parsePersistedAgentChatAttachments,
} from './agent-chat-attachment-persistence';
import type { AgentChatAttachment } from './agent-chat-drafts';
import {
    MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS,
    MAX_PERSISTED_AGENT_CHAT_DRAFTS,
} from './agent-chat-drafts';

/**
 * A device-local saved input, including the mode and caret that give its text meaning.
 */
export interface AgentChatDraftStash {
    text: string;
    attachments: readonly AgentChatAttachment[];
    selectionStart: number;
    selectionEnd: number;
    selectionDirection: 'backward' | 'forward' | 'none';
    isGoalMode: boolean;
}

interface StashRecord extends PersistedAgentChatAttachmentRecord {
    draft: Omit<AgentChatDraftStash, 'attachments'>;
}

function parseStashRecord(value: unknown): StashRecord | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const { attachments, draft, terminalId, updatedAt } = value as Record<string, unknown>;
    if (
        typeof terminalId !== 'string' ||
        !terminalId ||
        typeof updatedAt !== 'number' ||
        typeof draft !== 'object' ||
        draft === null ||
        !Number.isFinite(updatedAt)
    )
        return undefined;
    const { isGoalMode, selectionDirection, selectionEnd, selectionStart, text } = draft as Record<
        string,
        unknown
    >;
    if (
        typeof text !== 'string' ||
        typeof selectionStart !== 'number' ||
        typeof selectionEnd !== 'number' ||
        typeof isGoalMode !== 'boolean' ||
        (selectionDirection !== 'backward' &&
            selectionDirection !== 'forward' &&
            selectionDirection !== 'none') ||
        text.length > MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS ||
        selectionStart < 0 ||
        selectionEnd < selectionStart ||
        selectionEnd > text.length ||
        !Number.isSafeInteger(selectionStart) ||
        !Number.isSafeInteger(selectionEnd)
    )
        return undefined;
    return {
        terminalId,
        updatedAt,
        attachments: parsePersistedAgentChatAttachments(attachments),
        draft: { text, selectionStart, selectionEnd, selectionDirection, isGoalMode },
    };
}

/**
 * Stores each complete stash in one committed IndexedDB record, so clearing the input never outruns saving its images.
 * Reads deliberately keep the saved copy until the next stash overwrites it: restoring the composer writes text and
 * images through different existing stores, and quitting between those writes must not destroy the only complete copy.
 * The interaction follows https://code.claude.com/docs/en/interactive-mode#keyboard-shortcuts.
 */
export function createAgentChatDraftStashStore({
    backend,
    limit = MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS,
    countLimit = MAX_PERSISTED_AGENT_CHAT_DRAFTS,
    now = Date.now,
}: {
    backend: AgentChatAttachmentBackend;
    limit?: number;
    countLimit?: number;
    now?: () => number;
}) {
    const records = new Map<string, StashRecord>();
    const state: { hydrated?: Promise<void>; queue: Promise<void> } = { queue: Promise.resolve() };
    const hydrate = (): Promise<void> => {
        state.hydrated ??= (async () => {
            try {
                const values = await backend.readAll();
                for (const value of values) {
                    const record = parseStashRecord(value);
                    if (record) records.set(record.terminalId, record);
                }
            } catch (error) {
                delete state.hydrated;
                throw error;
            }
        })();
        return state.hydrated;
    };
    const serialized = <T>(run: () => Promise<T>): Promise<T> => {
        const previous = state.queue;
        const result = (async () => {
            await previous;
            return run();
        })();
        state.queue = (async () => {
            try {
                await result;
            } catch {
                // A failed request must not prevent the next checkpoint from being saved.
            }
        })();
        return result;
    };
    const prune = async (kept?: string): Promise<void> => {
        const newest = records
            .values()
            .toArray()
            .toSorted(
                (left, right) =>
                    Number(right.terminalId === kept) - Number(left.terminalId === kept) ||
                    right.updatedAt - left.updatedAt ||
                    left.terminalId.localeCompare(right.terminalId),
            );
        const removed: string[] = [];
        let characters = 0;
        let textCharacters = 0;
        let count = 0;
        for (const record of newest) {
            const nextCharacters =
                characters +
                record.draft.text.length +
                agentChatAttachmentCharacters(record.attachments);
            const nextTextCharacters = textCharacters + record.draft.text.length;
            if (
                count >= countLimit ||
                nextCharacters > limit ||
                nextTextCharacters > MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS
            ) {
                removed.push(record.terminalId);
                continue;
            }
            count += 1;
            characters = nextCharacters;
            textCharacters = nextTextCharacters;
        }
        await Promise.all(
            removed.map(async (terminalId) => {
                await backend.delete(terminalId);
                records.delete(terminalId);
            }),
        );
    };
    return {
        save: (terminalId: string, stash: AgentChatDraftStash): Promise<void> =>
            serialized(async () => {
                await hydrate();
                if (
                    stash.text.length > MAX_PERSISTED_AGENT_CHAT_DRAFT_CHARACTERS ||
                    stash.text.length + agentChatAttachmentCharacters(stash.attachments) > limit ||
                    countLimit < 1
                )
                    throw new Error('This draft is too large to stash.');
                const { attachments, ...draft } = stash;
                const record: StashRecord = {
                    terminalId,
                    draft,
                    attachments: [...attachments],
                    updatedAt: now(),
                };
                await backend.put(record);
                records.set(terminalId, record);
                await prune(terminalId);
            }),
        read: (terminalId: string): Promise<AgentChatDraftStash | undefined> =>
            serialized(async () => {
                await hydrate();
                await prune();
                const record = records.get(terminalId);
                return record
                    ? { ...record.draft, attachments: [...record.attachments] }
                    : undefined;
            }),
    };
}

export function agentChatDraftStashDatabaseName(scope: string): string {
    return `caxri-agent-chat-stashes:${scope}`;
}

const scopedStores = new Map<string, ReturnType<typeof createAgentChatDraftStashStore>>();

/**
 * The same window and environment partition as ordinary unsent drafts, captured before any asynchronous work.
 */
export function currentAgentChatDraftStashStore(): ReturnType<
    typeof createAgentChatDraftStashStore
> {
    const scope = currentAgentChatComposerScope();
    const current = scopedStores.get(scope);
    if (current) return current;
    const store = createAgentChatDraftStashStore({
        backend: indexedDatabaseAgentChatAttachmentBackend(() =>
            agentChatDraftStashDatabaseName(scope),
        ),
    });
    scopedStores.set(scope, store);
    return store;
}

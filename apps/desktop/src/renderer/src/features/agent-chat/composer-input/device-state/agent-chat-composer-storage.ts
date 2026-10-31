import type { AgentChatImageInput, DeviceStoreBackend } from '@caxri/protocol';
import { agentChatImageInputSchema, createDeviceStore } from '@caxri/protocol';
import { z } from 'zod';

import type { AgentChatEdit } from '../../composer/agent-chat-edit';

/**
 * Unsent composer state per Chat on this device, kept across a restart in the device store (`createDeviceStore`): one
 * entry per Chat and kind, in the IndexedDB database of the window's composer scope (`agentChatComposerDatabaseName`).
 * It lives on the device, never in Server Core, since it is this device's unsent input rather than Session state.
 *
 * One entry per Chat is what lets two windows of one scope save drafts for different Chats without overwriting each
 * other, and lets an image-heavy Chat (about 27 MB once base64-encoded) coexist with the small text entries.
 */

/**
 * One attachment as stored; the composer's `AgentChatAttachment` has the same shape, thumbnail included, so a restored
 * chip shows at once without decoding the image again. A file or folder card stores only its path, a skill card only
 * the skill's name.
 */
export type PersistedAgentChatAttachment =
    | {
          id: string;
          image: AgentChatImageInput;
          name?: string;
          isResized?: boolean;
          token?: number;
      }
    | { id: string; path: string; isDirectory: boolean }
    | { id: string; skill: string };

/**
 * Bumped when an entry's shape changes; an entry from another version is dropped rather than migrated.
 */
const COMPOSER_STORAGE_VERSION = 1;

/**
 * Typing writes the draft on every keystroke; storage is written once the typing pauses, and right away when the window
 * is hidden or closed, so a quit loses at most this window of keystrokes.
 */
const COMPOSER_WRITE_DELAY_MS = 300;

/**
 * Bounds on what is persisted per kind, newest first. A Chat that is deleted never clears its draft or edit, and one
 * draft may be as long as a message (100,000 characters), so without a bound the database grows until the disk quota
 * refuses every write. The counts are Chats; the characters are those of the stored entries.
 */
export const MAX_PERSISTED_AGENT_CHAT_DRAFTS = 50;
export const MAX_PERSISTED_AGENT_CHAT_EDITS = 50;
export const MAX_PERSISTED_AGENT_CHAT_TEXT_CHARACTERS = 1_000_000;
/**
 * Encoded characters (image data plus thumbnail) kept across all Chats: a few Chats at the per-message image limit.
 */
export const MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS = 128 * 1024 * 1024;

export type AgentChatComposerEntryKind = 'attachments' | 'draft' | 'edit';

const KINDS: readonly AgentChatComposerEntryKind[] = ['attachments', 'draft', 'edit'];

export function agentChatComposerEntryName(
    kind: AgentChatComposerEntryKind,
    terminalId: string,
): string {
    return `${kind}:${terminalId}`;
}

function parseEntryName(
    name: string,
): { kind: AgentChatComposerEntryKind; terminalId: string } | undefined {
    const separator = name.indexOf(':');
    if (separator === -1) return undefined;
    const kind = KINDS.find((candidate) => candidate === name.slice(0, separator));
    const terminalId = name.slice(separator + 1);
    return kind && terminalId ? { kind, terminalId } : undefined;
}

/**
 * Reads a stored attachment list. Anything malformed is dropped attachment by attachment rather than trusted: the store
 * is written only by this module, but a corrupt profile must not break the composer or send a broken image.
 */
export function parsePersistedAgentChatAttachments(value: unknown): PersistedAgentChatAttachment[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry: unknown): PersistedAgentChatAttachment[] => {
        if (typeof entry !== 'object' || entry === null) return [];
        const { id, image, isDirectory, isResized, name, path, skill, token } = entry as Record<
            string,
            unknown
        >;
        if (typeof id !== 'string' || !id) return [];
        if (typeof path === 'string' && path.startsWith('/'))
            return [{ id, path, isDirectory: isDirectory === true }];
        if (typeof skill === 'string' && skill) return [{ id, skill }];
        const parsed = agentChatImageInputSchema.safeParse(image);
        if (!parsed.success) return [];
        return [
            {
                id,
                image: parsed.data,
                ...(typeof name === 'string' && { name }),
                ...(isResized === true && { isResized }),
                ...(typeof token === 'number' &&
                    Number.isSafeInteger(token) &&
                    token > 0 && { token }),
            },
        ];
    });
}

const draftSchema = z.string().min(1);
const editSchema = z.strictObject({
    itemId: z.string().min(1),
    restoreFiles: z.boolean(),
    previousDraft: z.string(),
    appendedDraft: z.string(),
});
const attachmentsSchema = z.array(z.unknown()).transform(parsePersistedAgentChatAttachments);

/**
 * What an earlier run left for one scope.
 */
export interface RestoredAgentChatComposerState {
    attachments: Map<string, PersistedAgentChatAttachment[]>;
    drafts: Map<string, string>;
    edits: Map<string, AgentChatEdit>;
}

/**
 * Mirrors one scope's composer state into `backend`. The device store owns write ordering, debouncing, bounds, and
 * failure handling: every failure loses an unsent copy, never fails the composer.
 */
export function createAgentChatComposerStorage({
    backend,
    now,
    scope,
}: {
    backend: DeviceStoreBackend;
    now?: () => number;
    scope: string;
}) {
    const store = createDeviceStore({
        backend,
        now,
        retention: [
            {
                isBounded: (name) => name.startsWith('draft:'),
                maxCharacters: MAX_PERSISTED_AGENT_CHAT_TEXT_CHARACTERS,
                maxEntries: MAX_PERSISTED_AGENT_CHAT_DRAFTS,
            },
            {
                isBounded: (name) => name.startsWith('edit:'),
                maxCharacters: MAX_PERSISTED_AGENT_CHAT_TEXT_CHARACTERS,
                maxEntries: MAX_PERSISTED_AGENT_CHAT_EDITS,
            },
            {
                isBounded: (name) => name.startsWith('attachments:'),
                maxCharacters: MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS,
            },
        ],
        version: COMPOSER_STORAGE_VERSION,
        writeDelayMs: COMPOSER_WRITE_DELAY_MS,
    });
    store.setScope(scope);
    const saveOrRemove = (
        kind: AgentChatComposerEntryKind,
        terminalId: string,
        value: unknown,
        isEmpty: boolean,
    ): void => {
        const name = agentChatComposerEntryName(kind, terminalId);
        if (isEmpty) store.remove(name);
        else store.save(scope, name, value);
    };
    return {
        flush: store.flush,
        /**
         * Reads every entry an earlier run left. `isRetained` is asked for each Chat's edit and images, which are
         * removed instead of restored once the Workbench reported the Chat gone; a draft is always restored.
         */
        async hydrate(
            isRetained: (terminalId: string) => boolean,
        ): Promise<RestoredAgentChatComposerState> {
            const restored: RestoredAgentChatComposerState = {
                attachments: new Map(),
                drafts: new Map(),
                edits: new Map(),
            };
            let names: string[] = [];
            try {
                names = (await backend.list()).map((entry) => entry.name);
            } catch {
                // An unreadable store restores nothing; the composer starts empty as before.
            }
            await Promise.all(
                names.map(async (name) => {
                    const parsed = parseEntryName(name);
                    if (!parsed) return;
                    const { kind, terminalId } = parsed;
                    if (kind !== 'draft' && !isRetained(terminalId)) {
                        store.remove(name);
                        return;
                    }
                    if (kind === 'draft') {
                        const entry = await store.load(scope, name, draftSchema);
                        if (entry) restored.drafts.set(terminalId, entry.value);
                    } else if (kind === 'edit') {
                        const entry = await store.load(scope, name, editSchema);
                        if (entry) restored.edits.set(terminalId, entry.value);
                    } else {
                        const entry = await store.load(scope, name, attachmentsSchema);
                        if (entry && entry.value.length > 0)
                            restored.attachments.set(terminalId, entry.value);
                    }
                }),
            );
            return restored;
        },
        saveAttachments: (
            terminalId: string,
            attachments: readonly PersistedAgentChatAttachment[],
        ): void => saveOrRemove('attachments', terminalId, attachments, attachments.length === 0),
        saveDraft: (terminalId: string, text: string): void =>
            saveOrRemove('draft', terminalId, text, text === ''),
        saveEdit: (terminalId: string, edit: AgentChatEdit | undefined): void =>
            saveOrRemove('edit', terminalId, edit, edit === undefined),
    };
}

export type AgentChatComposerStorage = ReturnType<typeof createAgentChatComposerStorage>;

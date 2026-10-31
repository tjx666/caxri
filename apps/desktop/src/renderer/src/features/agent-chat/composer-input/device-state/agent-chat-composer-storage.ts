import type { AgentChatImageInput, DeviceStoreBackend, DeviceStoreListing } from '@caxri/protocol';
import {
    agentChatImageInputSchema,
    createDeviceStore,
    decodeDeviceStoreEntry,
} from '@caxri/protocol';
import { z } from 'zod';

import type { AgentChatEdit } from '../../composer/agent-chat-edit';

/**
 * Unsent composer state per Chat on this device, kept across a restart in the device store (`createDeviceStore`): one
 * entry per Chat and kind, under the window's composer scope. It lives on the device, never in Server Core, since it is
 * this device's unsent input rather than Session state.
 *
 * Text (drafts and "Edit from here") and images live in two backends of that scope. Text goes to a synchronous one
 * (`localStorage`): a draft flushed from `pagehide` must be on disk before the window reloads or quits, which an
 * IndexedDB transaction started there is not, and a reloaded Chat must show its draft on first paint. Images, about 27
 * MB per Chat once base64-encoded, would exhaust that quota, so they go to the scope's IndexedDB database
 * (`agentChatComposerDatabaseName`) and are written as soon as they change.
 *
 * One entry per Chat is what lets two windows of one scope save drafts for different Chats without overwriting each
 * other.
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
 * Typing writes the draft on every keystroke; storage is written once the typing pauses, and right away (synchronously)
 * when the window is hidden or closed.
 */
const COMPOSER_TEXT_WRITE_DELAY_MS = 300;

/**
 * Bounds on what is persisted per kind, newest first. A Chat that is deleted never clears its draft or edit, and one
 * draft may be as long as a message (100,000 characters), so without a bound the database grows until the disk quota
 * refuses every write. The counts are Chats; the characters are those of the stored entries.
 */
export const MAX_PERSISTED_AGENT_CHAT_DRAFTS = 50;
const MAX_PERSISTED_AGENT_CHAT_EDITS = 50;
const MAX_PERSISTED_AGENT_CHAT_TEXT_CHARACTERS = 1_000_000;
/**
 * Encoded characters (image data plus thumbnail) kept across all Chats: a few Chats at the per-message image limit.
 */
const MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS = 128 * 1024 * 1024;

export type AgentChatComposerEntryKind = 'attachments' | 'draft' | 'edit';

const KINDS: readonly AgentChatComposerEntryKind[] = ['attachments', 'draft', 'edit'];

function agentChatComposerEntryName(kind: AgentChatComposerEntryKind, terminalId: string): string {
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
function parsePersistedAgentChatAttachments(value: unknown): PersistedAgentChatAttachment[] {
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
 * The text an earlier run left for one scope.
 */
export interface RestoredAgentChatComposerText {
    drafts: Map<string, string>;
    edits: Map<string, AgentChatEdit>;
}

/**
 * The backends of one composer scope.
 */
export interface AgentChatComposerBackends {
    /**
     * Images, kept apart from text because of their size.
     */
    attachments: DeviceStoreBackend;
    /**
     * Drafts and edits. It must answer synchronously: text is read before the first paint and written from `pagehide`.
     */
    text: SynchronousDeviceStoreBackend;
}

/**
 * A backend whose every call finishes on the caller's tick, such as `localStorageDeviceStoreBackend`.
 */
export interface SynchronousDeviceStoreBackend extends DeviceStoreBackend {
    clear(): void;
    count?(): number;
    list(): DeviceStoreListing;
    read(name: string): string | null;
    remove(name: string): void;
    write(name: string, text: string): void;
}

/**
 * Mirrors one scope's composer state into its backends. The device store owns write ordering, debouncing, bounds, and
 * failure handling: every failure loses an unsent copy, never fails the composer.
 */
export function createAgentChatComposerStorage({
    backends,
    now,
    scope,
}: {
    backends: AgentChatComposerBackends;
    now?: () => number;
    scope: string;
}) {
    const textStore = createDeviceStore({
        backend: backends.text,
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
        ],
        version: COMPOSER_STORAGE_VERSION,
        writeDelayMs: COMPOSER_TEXT_WRITE_DELAY_MS,
    });
    const attachmentStore = createDeviceStore({
        backend: backends.attachments,
        now,
        retention: {
            isBounded: (name) => name.startsWith('attachments:'),
            maxCharacters: MAX_PERSISTED_AGENT_CHAT_ATTACHMENT_CHARACTERS,
        },
        version: COMPOSER_STORAGE_VERSION,
        // Written at once: images change on a paste or a removal, never per keystroke.
        writeDelayMs: 0,
    });
    textStore.setScope(scope);
    attachmentStore.setScope(scope);
    const saveOrRemove = (
        store: ReturnType<typeof createDeviceStore>,
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
        /**
         * Writes everything still waiting. Text is on disk when this returns; images are on their way.
         */
        flush: (): void => {
            void textStore.flush();
            void attachmentStore.flush();
        },
        /**
         * Reads the drafts and edits an earlier run left, synchronously. `isRetained` is asked for each Chat's edit,
         * which is removed instead of restored once the Workbench reported the Chat gone; a draft is always restored.
         */
        hydrateText(isRetained: (terminalId: string) => boolean): RestoredAgentChatComposerText {
            const restored: RestoredAgentChatComposerText = { drafts: new Map(), edits: new Map() };
            try {
                for (const { name } of backends.text.list()) {
                    const parsed = parseEntryName(name);
                    if (!parsed || parsed.kind === 'attachments') continue;
                    const { kind, terminalId } = parsed;
                    if (kind === 'edit' && !isRetained(terminalId)) {
                        textStore.remove(name);
                        continue;
                    }
                    const text = backends.text.read(name);
                    if (text === null) continue;
                    if (kind === 'draft') {
                        const entry = decodeDeviceStoreEntry(
                            text,
                            COMPOSER_STORAGE_VERSION,
                            scope,
                            draftSchema,
                        );
                        if (entry) restored.drafts.set(terminalId, entry.value);
                    } else {
                        const entry = decodeDeviceStoreEntry(
                            text,
                            COMPOSER_STORAGE_VERSION,
                            scope,
                            editSchema,
                        );
                        if (entry) restored.edits.set(terminalId, entry.value);
                    }
                }
            } catch {
                // An unreadable store restores nothing; the composer starts empty as before.
            }
            return restored;
        },
        /**
         * Reads the images an earlier run left. `isRetained` is asked for each Chat, whose images are removed instead
         * of restored once the Workbench reported it gone.
         */
        async hydrateAttachments(
            isRetained: (terminalId: string) => boolean,
        ): Promise<Map<string, PersistedAgentChatAttachment[]>> {
            const restored = new Map<string, PersistedAgentChatAttachment[]>();
            let names: string[] = [];
            try {
                names = (await backends.attachments.list()).map((entry) => entry.name);
            } catch {
                // An unreadable store restores nothing; the composer starts empty as before.
            }
            await Promise.all(
                names.map(async (name) => {
                    const parsed = parseEntryName(name);
                    if (parsed?.kind !== 'attachments') return;
                    if (!isRetained(parsed.terminalId)) {
                        attachmentStore.remove(name);
                        return;
                    }
                    const entry = await attachmentStore.load(scope, name, attachmentsSchema);
                    if (entry && entry.value.length > 0)
                        restored.set(parsed.terminalId, entry.value);
                }),
            );
            return restored;
        },
        saveAttachments: (
            terminalId: string,
            attachments: readonly PersistedAgentChatAttachment[],
        ): void =>
            saveOrRemove(
                attachmentStore,
                'attachments',
                terminalId,
                attachments,
                attachments.length === 0,
            ),
        saveDraft: (terminalId: string, text: string): void =>
            saveOrRemove(textStore, 'draft', terminalId, text, text === ''),
        /**
         * Stores or ends a Chat's edit, written at once: an edit starts and ends on a click, never per keystroke.
         */
        saveEdit: (terminalId: string, edit: AgentChatEdit | undefined): void => {
            saveOrRemove(textStore, 'edit', terminalId, edit, edit === undefined);
            void textStore.flush();
        },
    };
}

export type AgentChatComposerStorage = ReturnType<typeof createAgentChatComposerStorage>;

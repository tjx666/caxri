import type { DeviceStoreBackend } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';

import { indexedDatabaseDeviceStoreBackend } from '../../../../lib/indexed-database-device-store';
import type { AgentChatEdit } from '../../composer/agent-chat-edit';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import { didDeliverToMountedComposer, notifyDraftChange } from './agent-chat-composer-listeners';
import {
    agentChatComposerDatabaseName,
    currentAgentChatComposerScope,
} from './agent-chat-composer-scope';
import type {
    AgentChatComposerStorage,
    RestoredAgentChatComposerState,
} from './agent-chat-composer-storage';
import { createAgentChatComposerStorage } from './agent-chat-composer-storage';

/**
 * How long a Chat pane waits for the stored composer state before it opens without it. A broken or very slow database
 * must not leave the Chat blank; what arrives later still fills in whatever the user has not touched.
 */
const HYDRATION_PATIENCE_MS = 2_000;

/**
 * What hydration put into a scope's memory after the composer may already have read it, for the surfaces that render
 * from it.
 */
export interface AgentChatComposerRestoration {
    attachments: ReadonlyMap<string, AgentChatAttachment[]>;
    draftTerminalIds: readonly string[];
}

export interface AgentChatComposerStateOptions {
    /**
     * The backend of one composer scope, or `undefined` when the profile has no IndexedDB: state then lives in memory
     * only.
     */
    openBackend: ((scope: string) => DeviceStoreBackend) | undefined;
    onRestored: (restoration: AgentChatComposerRestoration) => void;
    scope: () => string;
    now?: () => number;
}

interface ScopeData {
    attachments: Map<string, AgentChatAttachment[]>;
    /**
     * Chats whose images changed in this run, which hydration must not overwrite.
     */
    changedAttachments: Set<string>;
    drafts: Map<string, string>;
    edits: Map<string, AgentChatEdit>;
    isReady: boolean;
    retained?: ReadonlySet<string>;
    scope: string;
    storage?: AgentChatComposerStorage;
}

/**
 * The composer state of the window's current scope: unsent text, "Edit from here", and images per Chat, in memory for
 * synchronous reads and mirrored into the device store (`createAgentChatComposerStorage`). Plain maps rather than a
 * store: nothing renders from them, and they hold the user's own message, which stays out of the `__caxriStores`
 * debugging snapshot.
 *
 * The scope is read at each use, so a Workbench that learns its environment after load keys its state by it; the
 * earlier scope keeps its own data and its own pending writes, which land under the scope they were typed in. Hydration
 * reads what an earlier run left, once per scope. Readers that need the stored state before they mount (the Chat pane)
 * wait on `isReady`.
 */
export function createAgentChatComposerState(options: AgentChatComposerStateOptions) {
    const scopes = new Map<string, ScopeData>();
    const readyListeners = new Set<() => void>();
    const { now, onRestored, openBackend } = options;

    const notifyReady = (): void => {
        notifyListeners(readyListeners, undefined);
    };

    const applyRestored = (data: ScopeData, restored: RestoredAgentChatComposerState): void => {
        const draftTerminalIds: string[] = [];
        for (const [terminalId, text] of restored.drafts) {
            if (data.drafts.has(terminalId)) continue;
            data.drafts.set(terminalId, text);
            draftTerminalIds.push(terminalId);
        }
        for (const [terminalId, edit] of restored.edits)
            if (!data.edits.has(terminalId)) data.edits.set(terminalId, edit);
        const attachments = new Map<string, AgentChatAttachment[]>();
        for (const [terminalId, list] of restored.attachments)
            if (!data.changedAttachments.has(terminalId)) {
                attachments.set(terminalId, list);
                if (!data.attachments.has(terminalId)) data.attachments.set(terminalId, list);
            }
        data.changedAttachments.clear();
        if (options.scope() === data.scope) onRestored({ attachments, draftTerminalIds });
    };

    const hydrate = (data: ScopeData): void => {
        const { storage } = data;
        if (!storage) {
            data.isReady = true;
            return;
        }
        const finish = (): void => {
            if (data.isReady) return;
            data.isReady = true;
            notifyReady();
        };
        const patience = setTimeout(finish, HYDRATION_PATIENCE_MS);
        void storage
            .hydrate((terminalId) => data.retained?.has(terminalId) ?? true)
            .then((restored) => applyRestored(data, restored))
            .catch(() => {})
            .finally(() => {
                clearTimeout(patience);
                finish();
            });
    };

    const current = (): ScopeData => {
        const scope = options.scope();
        let data = scopes.get(scope);
        if (data) return data;
        data = {
            attachments: new Map(),
            changedAttachments: new Set(),
            drafts: new Map(),
            edits: new Map(),
            isReady: false,
            scope,
            storage: openBackend
                ? createAgentChatComposerStorage({ backend: openBackend(scope), now, scope })
                : undefined,
        };
        scopes.set(scope, data);
        hydrate(data);
        // Not during the render that asked: a new scope is not ready, which mounted panes learn on their next read.
        queueMicrotask(notifyReady);
        return data;
    };

    return {
        attachments: () => current().attachments,
        drafts: () => current().drafts,
        edits: () => current().edits,
        /**
         * Starts writing everything still waiting, for a window that is going away. Every failure loses an unsent copy
         * and never surfaces, so there is nothing to await.
         */
        flush: (): void => {
            for (const data of scopes.values()) void data.storage?.flush();
        },
        /**
         * Whether the current scope's stored state has been read, or given up on.
         */
        isReady: (): boolean => current().isReady,
        /**
         * Drops the images and "Edit from here" of every Chat outside `chatTerminalIds` in the current scope, in memory
         * and stored, including those hydration has yet to read. Text drafts are kept: they are bounded by recency, and
         * dropping one on a transient snapshot gap would lose typed text that should survive a restart.
         */
        retain: (chatTerminalIds: ReadonlySet<string>): void => {
            const data = current();
            data.retained = chatTerminalIds;
            for (const terminalId of data.attachments.keys())
                if (!chatTerminalIds.has(terminalId)) {
                    data.attachments.delete(terminalId);
                    data.storage?.saveAttachments(terminalId, []);
                }
            for (const terminalId of data.edits.keys())
                if (!chatTerminalIds.has(terminalId)) {
                    data.edits.delete(terminalId);
                    data.storage?.saveEdit(terminalId, undefined);
                }
        },
        saveAttachments: (
            terminalId: string,
            attachments: readonly AgentChatAttachment[],
        ): void => {
            const data = current();
            data.changedAttachments.add(terminalId);
            data.storage?.saveAttachments(terminalId, attachments);
        },
        saveDraft: (terminalId: string, text: string): void =>
            current().storage?.saveDraft(terminalId, text),
        /**
         * Stores or ends a Chat's edit, written at once: an edit starts and ends on a click, never per keystroke.
         */
        saveEdit: (terminalId: string, edit: AgentChatEdit | undefined): void => {
            const storage = current().storage;
            storage?.saveEdit(terminalId, edit);
            void storage?.flush();
        },
        subscribeReady: (listener: () => void): (() => void) => {
            readyListeners.add(listener);
            return () => readyListeners.delete(listener);
        },
    };
}

export type AgentChatComposerState = ReturnType<typeof createAgentChatComposerState>;

/**
 * Opens the IndexedDB database of a composer scope; the profile has none under Vitest's Node environment.
 */
export function openAgentChatComposerBackend():
    ((scope: string) => DeviceStoreBackend) | undefined {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- absent under Vitest's Node environment
    return typeof indexedDB === 'undefined'
        ? undefined
        : (scope) => indexedDatabaseDeviceStoreBackend(agentChatComposerDatabaseName(scope));
}

/**
 * This window's composer state. Loading the module opens nothing: a scope's database opens on its first use.
 */
export const agentChatComposerState = createAgentChatComposerState({
    openBackend: openAgentChatComposerBackend(),
    // A Chat's composer already on screen takes restored images the way it takes a failed send's images back; the
    // surfaces that render from a draft hear it arrive.
    onRestored: ({ attachments, draftTerminalIds }) => {
        for (const terminalId of draftTerminalIds) notifyDraftChange(terminalId);
        for (const [terminalId, list] of attachments)
            didDeliverToMountedComposer(terminalId, '', list);
    },
    scope: currentAgentChatComposerScope,
});

// oxlint-disable-next-line typescript/no-unnecessary-condition -- absent under Vitest's Node environment
if (typeof window !== 'undefined') {
    // `pagehide` fires when the window closes or reloads, including a quit; `visibilitychange` covers the window being
    // hidden first. Either way the pending keystrokes reach storage before the Renderer can go away.
    window.addEventListener('pagehide', () => {
        agentChatComposerState.flush();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') agentChatComposerState.flush();
    });
}

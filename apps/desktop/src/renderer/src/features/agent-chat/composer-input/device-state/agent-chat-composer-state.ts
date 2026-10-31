import { notifyListeners } from '@caxri/utils';

import { indexedDatabaseDeviceStoreBackend } from '../../../../lib/indexed-database-device-store';
import { localStorageDeviceStoreBackend } from '../../../../lib/local-storage-device-store';
import type { AgentChatEdit } from '../../composer/agent-chat-edit';
import type { AgentChatAttachment } from '../agent-chat-drafts';
import { didDeliverToMountedComposer, notifyDraftChange } from './agent-chat-composer-listeners';
import {
    agentChatComposerDatabaseName,
    agentChatComposerTextKeyPrefix,
    currentAgentChatComposerScope,
} from './agent-chat-composer-scope';
import type {
    AgentChatComposerBackends,
    AgentChatComposerStorage,
    PersistedAgentChatAttachment,
} from './agent-chat-composer-storage';
import { createAgentChatComposerStorage } from './agent-chat-composer-storage';

/**
 * How long a Chat pane waits for the stored images before it opens without them. A broken or very slow database must
 * not leave the Chat blank; images that arrive later still reach a composer on screen through `onAttachmentsRestored`.
 */
const HYDRATION_PATIENCE_MS = 2_000;

export interface AgentChatComposerStateOptions {
    /**
     * The backends of one composer scope, or `undefined` when the profile has no device storage: state then lives in
     * memory only.
     */
    openBackends: ((scope: string) => AgentChatComposerBackends) | undefined;
    /**
     * Images that hydration put into a scope's memory after its composers may already have read it.
     */
    onAttachmentsRestored: (attachments: ReadonlyMap<string, AgentChatAttachment[]>) => void;
    /**
     * Chats whose draft hydration read, for the surfaces that render from a draft and may have read the scope before (a
     * scope that changed while running).
     */
    onDraftsRestored: (terminalIds: readonly string[]) => void;
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
    /**
     * Whether the stored images have been read, or given up on.
     */
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
 * reads what an earlier run left, once per scope: text synchronously on the scope's first use, so a composer that
 * mounts reads its draft at once; images from IndexedDB later. A composer takes its images only when it mounts (their
 * placeholders in the draft bind to them then), so the Chat pane waits on `isReady` before it renders.
 */
export function createAgentChatComposerState(options: AgentChatComposerStateOptions) {
    const scopes = new Map<string, ScopeData>();
    const readyListeners = new Set<() => void>();
    const { now, onAttachmentsRestored, onDraftsRestored, openBackends } = options;

    const notifyReady = (): void => {
        notifyListeners(readyListeners, undefined);
    };

    const applyRestoredAttachments = (
        data: ScopeData,
        restored: ReadonlyMap<string, PersistedAgentChatAttachment[]>,
    ): void => {
        const attachments = new Map<string, AgentChatAttachment[]>();
        for (const [terminalId, list] of restored)
            if (!data.changedAttachments.has(terminalId)) {
                attachments.set(terminalId, list);
                if (!data.attachments.has(terminalId)) data.attachments.set(terminalId, list);
            }
        data.changedAttachments.clear();
        if (options.scope() === data.scope) onAttachmentsRestored(attachments);
    };

    const hydrate = (data: ScopeData): void => {
        const { storage } = data;
        if (!storage) {
            data.isReady = true;
            return;
        }
        const isRetained = (terminalId: string): boolean => data.retained?.has(terminalId) ?? true;
        const text = storage.hydrateText(isRetained);
        for (const [terminalId, draft] of text.drafts) data.drafts.set(terminalId, draft);
        for (const [terminalId, edit] of text.edits) data.edits.set(terminalId, edit);
        if (text.drafts.size > 0) {
            const terminalIds = text.drafts.keys().toArray();
            // Not during the render that asked for the scope.
            queueMicrotask(() => onDraftsRestored(terminalIds));
        }
        const finish = (): void => {
            if (data.isReady) return;
            data.isReady = true;
            notifyReady();
        };
        const patience = setTimeout(finish, HYDRATION_PATIENCE_MS);
        void storage
            .hydrateAttachments(isRetained)
            .then((restored) => applyRestoredAttachments(data, restored))
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
            storage: openBackends
                ? createAgentChatComposerStorage({ backends: openBackends(scope), now, scope })
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
         * Writes everything still waiting, for a window that is going away: text is on disk when this returns, images
         * are on their way. Every failure loses an unsent copy and never surfaces, so there is nothing to await.
         */
        flush: (): void => {
            for (const data of scopes.values()) data.storage?.flush();
        },
        /**
         * Whether the current scope's stored images have been read, or given up on.
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
        saveEdit: (terminalId: string, edit: AgentChatEdit | undefined): void =>
            current().storage?.saveEdit(terminalId, edit),
        subscribeReady: (listener: () => void): (() => void) => {
            readyListeners.add(listener);
            return () => readyListeners.delete(listener);
        },
    };
}

/**
 * Opens the backends of a composer scope; the profile has none under Vitest's Node environment.
 */
function openAgentChatComposerBackends():
    ((scope: string) => AgentChatComposerBackends) | undefined {
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- absent under Vitest's Node environment
    return typeof indexedDB === 'undefined' || typeof localStorage === 'undefined'
        ? undefined
        : (scope) => ({
              attachments: indexedDatabaseDeviceStoreBackend(agentChatComposerDatabaseName(scope)),
              text: localStorageDeviceStoreBackend(agentChatComposerTextKeyPrefix(scope)),
          });
}

/**
 * This window's composer state. Loading the module opens nothing: a scope's database opens on its first use.
 */
export const agentChatComposerState = createAgentChatComposerState({
    openBackends: openAgentChatComposerBackends(),
    // A Chat's composer already on screen takes restored images the way it takes a failed send's images back.
    onAttachmentsRestored: (attachments) => {
        for (const [terminalId, list] of attachments)
            didDeliverToMountedComposer(terminalId, '', list);
    },
    onDraftsRestored: (terminalIds) => {
        for (const terminalId of terminalIds) notifyDraftChange(terminalId);
    },
    scope: currentAgentChatComposerScope,
});

// oxlint-disable-next-line typescript/no-unnecessary-condition -- absent under Vitest's Node environment
if (typeof window !== 'undefined') {
    // `pagehide` fires when the window closes or reloads, including a quit; `visibilitychange` covers the window being
    // hidden first. Either way the pending keystrokes reach `localStorage` before the Renderer can go away.
    window.addEventListener('pagehide', () => {
        agentChatComposerState.flush();
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') agentChatComposerState.flush();
    });
}

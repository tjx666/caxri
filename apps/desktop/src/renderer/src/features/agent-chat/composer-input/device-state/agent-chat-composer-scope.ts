import { environmentOfTerminal } from '../../../../lib/environment-routing';
import { removeLocalStorageEntriesByPrefix } from '../../../../lib/local-storage';
import { storageScopeOf } from '../../../../stores/environment';

/**
 * The Renderer window a store belongs to. The Caxri Bot window shows only its own Chat, which the Workbench snapshot
 * excludes, so it needs a scope of its own: otherwise the Workbench would prune Caxri Bot's images and edits as
 * unretained on every launch, and Caxri Bot would hydrate and evict every Workbench Chat's images.
 */
export type AgentChatComposerWindow = 'bot' | 'workbench';

/**
 * Which device-local composer state (unsent images, text drafts, "Edit from here") a Chat's composer uses: the Caxri
 * Bot window's own, or in a Workbench the scope of the machine running that Chat. Every window loads the same `file://`
 * origin and so shares IndexedDB; keeping each machine's Chats apart means reconciling the Chats one machine lists
 * never deletes another machine's, in particular a disconnected SSH Host's (see `retainAgentChatComposerState`). An SSH
 * Host is keyed by Main's resolved host key, so every alias of one account finds the same state after a relaunch.
 *
 * @param window The window kind the composer is in.
 * @param environmentId The SSH Host running the Chat, or `undefined` for this Mac.
 */
export function agentChatComposerScope(
    window: AgentChatComposerWindow,
    environmentId: string | undefined,
): string {
    if (window === 'bot') return 'bot';
    return storageScopeOf(environmentId);
}

const composerWindow: { kind: AgentChatComposerWindow } = { kind: 'workbench' };

/**
 * Marks this Renderer as the Caxri Bot window, which keeps its composer state in its own scope (see
 * `AgentChatComposerWindow`). Called from its entry before the first render, before any composer reads its state.
 */
export function configureAgentChatComposerWindowForBot(): void {
    composerWindow.kind = 'bot';
}

/**
 * The composer scope of one Chat in this window, or of this Mac for `undefined`. Read at each use: the Workbench
 * indexes an SSH Host's Chats when it reads that Host's snapshot, before any of their composers mount. The one
 * derivation the drafts, edits, and images share.
 */
export function currentAgentChatComposerScope(terminalId: string | undefined): string {
    const scope = agentChatComposerScope(composerWindow.kind, environmentOfTerminal(terminalId));
    removeSupersededAgentChatComposerState(scope);
    return scope;
}

/**
 * The IndexedDB database holding one composer scope's images; the local scope keeps the bare name.
 */
export function agentChatComposerDatabaseName(scope: string): string {
    return scope === 'local' ? 'caxri-agent-chat-composer' : `caxri-agent-chat-composer:${scope}`;
}

/**
 * The prefix of the `localStorage` keys holding one composer scope's drafts and edits.
 */
export function agentChatComposerTextKeyPrefix(scope: string): string {
    return `caxri.agent-chat.composer:${scope}:`;
}

/**
 * Where composer state lived before the device store held it: `localStorage` entries for drafts and edits (first one
 * unscoped, then one per scope), and an IndexedDB database of images (keyed by SSH destination, then by scope).
 */
const SUPERSEDED_STORAGE_KEY_PREFIXES = ['caxri.agent-chat.drafts', 'caxri.agent-chat.edits'];
const SUPERSEDED_DATABASE_NAME = 'caxri-agent-chat';
const cleanedScopes = new Set<string>();

/**
 * Deletes composer state stored under the superseded names once per scope and Renderer. Nothing reads those names any
 * more, and left behind they keep counting against the shared `localStorage` quota and the disk. This is cleanup, not a
 * migration: unsent drafts from a previous build are not carried over.
 */
function removeSupersededAgentChatComposerState(scope: string): void {
    if (cleanedScopes.has(scope)) return;
    cleanedScopes.add(scope);
    try {
        removeLocalStorageEntriesByPrefix(SUPERSEDED_STORAGE_KEY_PREFIXES);
        indexedDB.deleteDatabase(
            scope === 'local' ? SUPERSEDED_DATABASE_NAME : `${SUPERSEDED_DATABASE_NAME}:${scope}`,
        );
    } catch {
        // IndexedDB can be unavailable (a locked profile, or Vitest's Node environment); the leftovers are harmless.
    }
}

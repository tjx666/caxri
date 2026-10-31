import type { EnvironmentState } from '@caxri/protocol';

import { environmentStorageScope, useEnvironmentStore } from '../../../../stores/environment';

/**
 * The Renderer window a store belongs to. The Caxri Bot window shows only its own Chat, which the Workbench snapshot
 * excludes, so it needs a scope of its own: otherwise the Workbench would prune Caxri Bot's images and edits as
 * unretained on every launch, and Caxri Bot would hydrate and evict every Workbench Chat's images.
 */
export type AgentChatComposerWindow = 'bot' | 'workbench';

/**
 * Which device-local composer state (unsent images, text drafts, "Edit from here") one window owns: its window kind and
 * environment. Every window (local or SSH Host Workbench, and Caxri Bot) loads the same `file://` origin and so shares
 * IndexedDB, while each Workbench retains only its own environment's Chat Terminals; one shared store would let a
 * window delete every other environment's state as unretained. An SSH Host is keyed by Main's resolved host key, so
 * every alias of one account (which Main opens as one window) finds the same state after a relaunch, whichever alias
 * reconnected. A Workbench whose environment is not known yet uses the local scope: Main answers the environment before
 * the Server attaches, so a Workbench window knows it before any Chat composer exists.
 */
export function agentChatComposerScope(
    window: AgentChatComposerWindow,
    environment: EnvironmentState | undefined,
): string {
    if (window === 'bot') return 'bot';
    return environment ? environmentStorageScope(environment) : 'local';
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
 * This window's composer scope, read at each use so a Workbench that learns its environment after load keys its state
 * by it. The one derivation the drafts, edits, and images share.
 */
export function currentAgentChatComposerScope(): string {
    const environment = useEnvironmentStore.getState().state;
    const scope = agentChatComposerScope(composerWindow.kind, environment);
    removeSupersededAgentChatComposerState(scope, environment);
    return scope;
}

/**
 * The IndexedDB database holding one composer scope's entries; the local scope keeps the bare name.
 */
export function agentChatComposerDatabaseName(scope: string): string {
    return scope === 'local' ? 'caxri-agent-chat-composer' : `caxri-agent-chat-composer:${scope}`;
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
function removeSupersededAgentChatComposerState(
    scope: string,
    environment: EnvironmentState | undefined,
): void {
    if (cleanedScopes.has(scope)) return;
    cleanedScopes.add(scope);
    try {
        for (const key of Object.keys(localStorage))
            if (SUPERSEDED_STORAGE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
                localStorage.removeItem(key);
        indexedDB.deleteDatabase(
            scope === 'local' ? SUPERSEDED_DATABASE_NAME : `${SUPERSEDED_DATABASE_NAME}:${scope}`,
        );
        if (environment?.kind === 'ssh' && environment.destination !== environment.hostIdentity)
            indexedDB.deleteDatabase(`${SUPERSEDED_DATABASE_NAME}:ssh:${environment.destination}`);
    } catch {
        // Storage can be unavailable (a locked profile, or Vitest's Node environment); the leftovers are harmless.
    }
}

import type { AgentChatAttachment } from './agent-chat-drafts';

/**
 * A composer draft set aside with Ctrl+S, as Claude Code's `chat:stash` does: everything needed to put the composer
 * back the way it was.
 */
export interface AgentChatDraftStash {
    text: string;
    /**
     * Where the caret was, clamped to `text` when restored.
     */
    caret: number;
    attachments: readonly AgentChatAttachment[];
    isGoalMode: boolean;
}

/**
 * One stash per Chat Terminal, for the life of the window. Switching tabs or Sessions unmounts the composer, so the
 * stash lives here rather than in component state; like Claude Code's, it is not kept across a restart (the draft
 * itself is).
 */
const stashes = new Map<string, AgentChatDraftStash>();

export function readAgentChatDraftStash(terminalId: string): AgentChatDraftStash | undefined {
    return stashes.get(terminalId);
}

/**
 * Stores `stash`, replacing an earlier one, or clears it with `undefined`.
 */
export function writeAgentChatDraftStash(
    terminalId: string,
    stash: AgentChatDraftStash | undefined,
): void {
    if (stash) stashes.set(terminalId, stash);
    else stashes.delete(terminalId);
}

/**
 * Whether a key is the stash shortcut: Ctrl+S on every platform, as in Claude Code (Cmd+S stays the app's own), outside
 * IME composition.
 */
export function isAgentChatDraftStashKey(event: {
    key: string;
    altKey: boolean;
    ctrlKey: boolean;
    isComposing: boolean;
    metaKey: boolean;
    shiftKey: boolean;
}): boolean {
    return (
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        !event.shiftKey &&
        !event.isComposing &&
        event.key.toLowerCase() === 's'
    );
}

export type AgentChatStashAction = 'ignore' | 'refuse-occupied' | 'restore' | 'stash';

/**
 * What Ctrl+S does. A draft (text beyond whitespace, or an attachment) is stashed only when no stash exists; with one
 * waiting it is refused so the earlier stash is never overwritten. A whitespace-only input (a stray Shift+Enter) counts
 * as empty, so Ctrl+S restores. With nothing to stash or restore the key is left alone.
 */
export function decideAgentChatStashAction(state: {
    attachmentCount: number;
    draft: string;
    hasStash: boolean;
}): AgentChatStashAction {
    const hasDraft = state.draft.trim() !== '' || state.attachmentCount > 0;
    if (hasDraft) return state.hasStash ? 'refuse-occupied' : 'stash';
    return state.hasStash ? 'restore' : 'ignore';
}

/**
 * The text a restore leaves in the input: the stashed text unless the user already typed something real. Whitespace
 * alone does not count, or the stash (already cleared) would be lost.
 */
export function restoredAgentChatDraftText(current: string, savedText: string): string {
    return current.trim() === '' ? savedText : current;
}

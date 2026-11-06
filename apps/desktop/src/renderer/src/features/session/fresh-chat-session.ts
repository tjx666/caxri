import type { AppSettings, ProjectRecord, TerminalKind } from '@caxri/protocol';
import { canUseAgentChat, terminalKindSchema } from '@caxri/protocol';

import { createStore } from '../../lib/store';

/**
 * Sessions this window opened as fresh Chats from the Activity view's New Session entry (or `⌘N` while Activity shows).
 * Until their first message they may still move to another Project or Agent, and leaving one while it is empty discards
 * it. Window-local and in memory: a reload forgets the set, so those Sessions simply stay.
 */
interface FreshChatSessions {
    sessionIds: ReadonlySet<string>;
}

export const useFreshChatSessionStore = createStore<FreshChatSessions>(
    'fresh-chat-sessions',
    () => ({ sessionIds: new Set() }),
);

export function markFreshChatSession(sessionId: string): void {
    const { sessionIds } = useFreshChatSessionStore.getState();
    if (sessionIds.has(sessionId)) return;
    useFreshChatSessionStore.setState({ sessionIds: new Set([...sessionIds, sessionId]) });
}

/**
 * Removes `sessionId` from the set and answers whether it was there, so a caller claims a Session at most once.
 */
export function didClaimFreshChatSession(sessionId: string): boolean {
    const { sessionIds } = useFreshChatSessionStore.getState();
    if (!sessionIds.has(sessionId)) return false;
    const next = new Set(sessionIds);
    next.delete(sessionId);
    useFreshChatSessionStore.setState({ sessionIds: next });
    return true;
}

export function useIsFreshChatSession(sessionId: string | undefined): boolean {
    return useFreshChatSessionStore((state) =>
        sessionId === undefined ? false : state.sessionIds.has(sessionId),
    );
}

/**
 * The Agent a fresh Chat starts with: the configured default Agent, else the user's last pick, else the first Agent
 * that supports Chat. The first two are the same rule the split New Session press follows, so the entry never overrides
 * a per-user choice with a fixed provider. `undefined` means the entry cannot open a Chat (Agents open as Terminals, or
 * the default or last pick is a Shell or a Terminal-only Agent) and keeps repeating that choice.
 */
export function freshChatKind(
    defaultAgent: AppSettings['session.defaultAgent'] | undefined,
    openInChat: AppSettings['session.openAgentsInChat'] | undefined,
    lastChoice: TerminalKind | undefined,
): TerminalKind | undefined {
    if (openInChat !== true) return undefined;
    const chosen = defaultAgent ?? lastChoice;
    if (chosen) return canUseAgentChat(chosen) ? chosen : undefined;
    return terminalKindSchema.options.find((kind) => canUseAgentChat(kind));
}

/**
 * Every Agent a fresh Chat can switch to, in catalog order like the New Session list.
 */
export function freshChatKinds(): TerminalKind[] {
    return terminalKindSchema.options.filter((kind) => canUseAgentChat(kind));
}

/**
 * Placeholders the localized "Start in {{project}} with {{agent}}" sentence is rendered with, so each language keeps
 * its own word order around the two menus.
 */
export const FRESH_CHAT_PROJECT_SLOT = '\u{0}project\u{0}';
export const FRESH_CHAT_AGENT_SLOT = '\u{0}agent\u{0}';

/**
 * Splits the rendered sentence into its words and the two slots, dropping blank runs, each with a stable key.
 */
export function freshChatSentenceParts(sentence: string): Array<{ key: string; part: string }> {
    return sentence
        .split(/(\0project\0|\0agent\0)/u)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part, index) => ({ key: `${index}:${part}`, part }));
}

/**
 * The Projects a fresh Chat can move to, most recently visited first, so the likely target sits at the top.
 */
export function freshChatProjects(projects: readonly ProjectRecord[]): ProjectRecord[] {
    return projects.toSorted((left, right) => right.lastVisitedAt - left.lastVisitedAt);
}

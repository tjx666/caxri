import type { AgentAction } from '@caxri/protocol';

import { translate } from '../../../i18n';
import type { SuggestionOption } from '../../../lib/suggestion-options';
import type { SessionReferenceCandidate } from '../../session/session-reference';

export function agentChatActionSuggestion(action: AgentAction): SuggestionOption {
    return {
        key: action.invocation,
        label: action.invocation,
        isLabelLiteral: true,
        ...(action.argumentHint && { hint: action.argumentHint }),
        ...(action.description && { description: action.description }),
    };
}

export function agentChatSessionSuggestion(candidate: SessionReferenceCandidate): SuggestionOption {
    return {
        key: `session-${candidate.sessionId}`,
        label: candidate.title,
        isLabelLiteral: false,
        ...(candidate.projectTitle && { description: candidate.projectTitle }),
    };
}

/**
 * The `@` list's rows. Each names its Project; a title that more than one row shares (compared case-insensitively) also
 * carries when that Session was last opened, since two Sessions in one Project can share a title.
 */
export function agentChatSessionSuggestions(
    candidates: readonly SessionReferenceCandidate[],
    openedAt: ReadonlyMap<string, number>,
): SuggestionOption[] {
    const counts = new Map<string, number>();
    for (const { title } of candidates) {
        const key = title.toLowerCase();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return candidates.map((candidate) => {
        const suggestion = agentChatSessionSuggestion(candidate);
        const opened = openedAt.get(candidate.sessionId);
        return opened !== undefined && (counts.get(candidate.title.toLowerCase()) ?? 0) > 1
            ? { ...suggestion, openedAt: opened }
            : suggestion;
    });
}

/**
 * The keys a suggestion list's `meta` footer names. A list with no row to choose offers only Escape, so it never
 * promises an Enter that would send the draft instead.
 */
export function agentChatSuggestionFooter(
    list: 'commands' | 'sessions',
    hasMatches: boolean,
): string {
    if (!hasMatches) return translate('agentChat.slash.footerDismiss');
    return translate(
        list === 'commands' ? 'agentChat.slash.footerCommands' : 'agentChat.slash.footerSessions',
    );
}

/**
 * The `@` list's progress row while the chosen Session is condensed into a reference file.
 */
export function agentChatSessionPreparingText(title: string): string {
    return translate('agentChat.slash.preparingSession', { title });
}

/**
 * The caret the `@` Sessions list follows after the input reports a selection. A `select` event alone does not place
 * it: focus moving into a restored draft (showing the Chat, switching Sessions) reports one too, and a draft saved
 * ending in `@word` must not open the list before the user touches it. Once the user has edited the draft or moved the
 * caret (`current` is set), every selection moves it.
 */
export function agentChatSelectionCaret(
    current: number | undefined,
    selectionStart: number,
): number | undefined {
    return current === undefined ? undefined : selectionStart;
}

const CARET_KEYS = new Set([
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'End',
    'Home',
    'PageDown',
    'PageUp',
]);

/**
 * Whether a key released in the composer moved its caret on the user's behalf, so the `@` Sessions list may open at it.
 * A chord with Command, Control, or Option does not count: one that switches Sessions (`ctrl+alt+arrowleft`) is often
 * released over the composer it just focused.
 */
export function isAgentChatCaretKey(event: {
    altKey: boolean;
    ctrlKey: boolean;
    key: string;
    metaKey: boolean;
}): boolean {
    return CARET_KEYS.has(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey;
}

/**
 * Whether a key-up in the composer ends a caret move that started there: the released key is the unmodified caret key
 * the composer last saw pressed (`pressedKey`, see {@link isAgentChatCaretKey}). A chord releases its modifiers in any
 * order, so a Session switch whose Option comes up before its arrow would otherwise look like a plain arrow press on
 * the composer it just focused, which never saw the arrow go down.
 */
export function isAgentChatCaretKeyRelease(
    pressedKey: string | undefined,
    event: { altKey: boolean; ctrlKey: boolean; key: string; metaKey: boolean },
): boolean {
    return pressedKey === event.key && isAgentChatCaretKey(event);
}

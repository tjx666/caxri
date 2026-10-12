import type { KeyboardEvent } from 'react';

import { isEditableEventTarget } from '../../lib/keybindings';

/**
 * Marks a reply the keyboard can step to: one that carries a Copy action. It is focusable only from script
 * (`tabIndex={-1}`), so a long transcript gains no Tab stop per reply.
 */
export const AGENT_CHAT_NAVIGABLE_REPLY_ATTRIBUTE = 'data-agent-chat-reply-navigable';

/**
 * The chords that step focus between replies inside the transcript, as `aria-keyshortcuts` names them.
 */
export const AGENT_CHAT_REPLY_NAVIGATION_SHORTCUTS = 'Alt+ArrowUp Alt+ArrowDown';

/**
 * Where one reply sits relative to the focused element: before or after it, holding it (focus is in the reply), or held
 * by it (focus is on the transcript itself).
 */
export type AgentChatReplyRelation = 'before' | 'after' | 'contains' | 'inside';

export type AgentChatReplyDirection = 'previous' | 'next';

/**
 * `Option+ArrowUp` and `Option+ArrowDown`. Plain arrows keep scrolling the transcript, and `Option` alone moves nothing
 * there, so the chord takes nothing from the reader.
 */
export function agentChatReplyNavigationDirection(
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
): AgentChatReplyDirection | undefined {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return undefined;
    if (event.key === 'ArrowUp') return 'previous';
    if (event.key === 'ArrowDown') return 'next';
    return undefined;
}

/**
 * The reply to focus next, by index in document order, or `undefined` when there is none that way. From inside a reply
 * it steps to its neighbor; from another row it takes the nearest reply that way; from the transcript itself either
 * direction starts at the latest reply, the one a reader most often wants to copy.
 */
export function agentChatAdjacentReplyIndex(
    relations: readonly AgentChatReplyRelation[],
    direction: AgentChatReplyDirection,
): number | undefined {
    const step = direction === 'previous' ? -1 : 1;
    const current = relations.indexOf('contains');
    if (current !== -1) {
        const next = current + step;
        return next >= 0 && next < relations.length ? next : undefined;
    }
    if (relations.length > 0 && relations.every((relation) => relation === 'inside'))
        return relations.length - 1;
    const index =
        direction === 'previous' ? relations.lastIndexOf('before') : relations.indexOf('after');
    return index === -1 ? undefined : index;
}

function replyRelation(reply: Element, focused: Element): AgentChatReplyRelation {
    if (reply.contains(focused)) return 'contains';
    if (focused.contains(reply)) return 'inside';

    return reply.compareDocumentPosition(focused) & Node.DOCUMENT_POSITION_FOLLOWING
        ? 'before'
        : 'after';
}

/**
 * The transcript's keyboard path to a reply's Copy: the chord focuses a reply, which mounts its action row
 * (`AgentChatReplyFrame`), and Tab then reaches Copy. Handled on the transcript so it works from the transcript itself,
 * a reply, or any row in between, but never from an editable control such as a review comment.
 */
export function onAgentChatTranscriptKeyDown(event: KeyboardEvent<HTMLElement>): void {
    const direction = agentChatReplyNavigationDirection(event);
    const focused = event.target;
    if (!direction || !(focused instanceof Element) || isEditableEventTarget(focused)) return;
    const replies = [
        ...event.currentTarget.querySelectorAll<HTMLElement>(
            `[${CSS.escape(AGENT_CHAT_NAVIGABLE_REPLY_ATTRIBUTE)}]`,
        ),
    ];
    const index = agentChatAdjacentReplyIndex(
        replies.map((reply) => replyRelation(reply, focused)),
        direction,
    );
    event.preventDefault();
    if (index !== undefined) replies[index]?.focus();
}

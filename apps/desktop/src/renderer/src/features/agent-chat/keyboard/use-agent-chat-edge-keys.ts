import type { KeyboardEvent, RefObject } from 'react';

import { isImeComposing } from '../../../lib/ime';
import { isEditableEventTarget } from '../../../lib/keybindings';
import type { AgentChatComposerInput } from '../composer/agent-chat-composer-view';

export type AgentChatScrollEdge = 'top' | 'bottom';

/**
 * The transcript edge a key jumps to, as a page does in Chrome on macOS: `Home` or `Cmd+ArrowUp` to the top, `End` or
 * `Cmd+ArrowDown` to the bottom. Any other modifier (Shift extends a selection, Option steps between replies) keeps its
 * own meaning.
 */
export function agentChatScrollEdge(
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>,
): AgentChatScrollEdge | undefined {
    if (event.altKey || event.ctrlKey || event.shiftKey) return undefined;
    if (event.metaKey) {
        if (event.key === 'ArrowUp') return 'top';
        if (event.key === 'ArrowDown') return 'bottom';
        return undefined;
    }
    if (event.key === 'Home') return 'top';
    if (event.key === 'End') return 'bottom';
    return undefined;
}

/**
 * Where focus sits when an edge key is pressed, and whether that place lets the transcript take it: the transcript or a
 * row inside it, or the composer while its draft holds nothing but whitespace. A draft keeps the keys for its caret,
 * and so does any other editable field, such as a review comment inside the transcript.
 */
export function isAgentChatEdgeKeyTarget(target: {
    isComposerTarget: boolean;
    composerDraft: string;
    isTranscriptTarget: boolean;
    isEditableTarget: boolean;
}): boolean {
    if (target.isComposerTarget) return target.composerDraft.trim() === '';
    return target.isTranscriptTarget && !target.isEditableTarget;
}

/**
 * The Chat pane's bubble-phase handler for the edge keys ({@link agentChatScrollEdge}). Opening a Chat focuses its
 * composer, where these keys would only move the caret of an empty draft, so they scroll the transcript instead. Inside
 * the transcript Chromium would scroll it natively, but smoothly: while a reply streams, the first frames of a smooth
 * scroll up still sit within the follow threshold and the next patch pins the view back down. So the top is reached
 * instantly after following stops, and the bottom through Jump to latest, which resumes following.
 */
export function useAgentChatEdgeKeys({
    inputReference,
    jumpToLatest,
    scrollReference,
    stopFollowing,
}: {
    inputReference: RefObject<AgentChatComposerInput | null>;
    jumpToLatest: () => void;
    scrollReference: RefObject<HTMLDivElement | null>;
    stopFollowing: () => void;
}): (event: KeyboardEvent<HTMLElement>) => void {
    return (event) => {
        const edge = agentChatScrollEdge(event);
        const view = scrollReference.current;
        if (!edge || !view || isImeComposing(event)) return;
        const input = inputReference.current;
        const target = event.target instanceof Node ? event.target : null;
        const isTarget = isAgentChatEdgeKeyTarget({
            isComposerTarget: Boolean(target && input?.element?.contains(target)),
            composerDraft: input?.value ?? '',
            isTranscriptTarget: Boolean(target && view.contains(target)),
            isEditableTarget: isEditableEventTarget(event.target),
        });
        if (!isTarget) return;
        event.preventDefault();
        if (edge === 'bottom') {
            jumpToLatest();
            return;
        }
        stopFollowing();
        view.scrollTop = 0;
    };
}

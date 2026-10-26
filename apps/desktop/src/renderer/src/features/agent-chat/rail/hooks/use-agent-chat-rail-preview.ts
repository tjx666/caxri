import { useEffect, useMemo, useRef, useState } from 'react';

import type {
    AgentChatRailPreviewEvent,
    AgentChatRailPreviewState,
} from '../agent-chat-rail-preview';
import { agentChatRailPreviewStep } from '../agent-chat-rail-preview';

/**
 * The shared Tooltip's open and close delays (`TooltipProvider`), so the rail's card answers a hover at the same pace
 * as every other hover hint in the workbench.
 */
const OPEN_DELAY_MS = 500;
const CLOSE_DELAY_MS = 80;

/**
 * Drives the message rail's single preview card: which mark it shows, and the tick it is anchored to. Every tick
 * reports enter and leave (pointer or focus) here; {@link agentChatRailPreviewStep} decides, and the one timer this owns
 * is replaced on every step that schedules or cancels, so no delay outlives the tick it was started for.
 */
export function useAgentChatRailPreview(): {
    shownId: string | undefined;
    /**
     * The mark the card last showed, kept while it closes so its exit fades the same content instead of an empty frame.
     */
    displayedId: string | undefined;
    anchor: HTMLElement | null;
    enter: (id: string, element: HTMLElement) => void;
    leave: (id: string) => void;
    dismiss: () => void;
} {
    const [state, setState] = useState<AgentChatRailPreviewState>({});
    const [anchor, setAnchor] = useState<HTMLElement | null>(null);
    const [displayedId, setDisplayedId] = useState<string>();
    const current = useRef<AgentChatRailPreviewState>({});
    const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
    /**
     * The element of each tick the pointer or focus last entered, so the card anchors to the tick it previews.
     */
    const elements = useRef(new Map<string, HTMLElement>());
    useEffect(() => () => clearTimeout(timer.current), []);

    /**
     * Built once: the ticks are memoized on their props, so a fresh handler per render would re-render every tick each
     * time the card moves.
     */
    const actions = useMemo(() => {
        const dispatch = (event: AgentChatRailPreviewEvent): void => {
            const { state: next, effect } = agentChatRailPreviewStep(current.current, event);
            if (effect !== 'none') {
                clearTimeout(timer.current);
                timer.current = undefined;
            }
            if (effect === 'scheduleOpen' && next.pendingId !== undefined) {
                const id = next.pendingId;
                timer.current = setTimeout(
                    () => dispatch({ type: 'openElapsed', id }),
                    OPEN_DELAY_MS,
                );
            }
            if (effect === 'scheduleClose' && next.shownId !== undefined) {
                const id = next.shownId;
                timer.current = setTimeout(
                    () => dispatch({ type: 'closeElapsed', id }),
                    CLOSE_DELAY_MS,
                );
            }
            if (next === current.current) return;
            current.current = next;
            setState(next);
            if (next.shownId !== undefined) {
                setDisplayedId(next.shownId);
                setAnchor(elements.current.get(next.shownId) ?? null);
            }
            if (next.shownId === undefined && next.pendingId === undefined)
                elements.current.clear();
        };
        return {
            enter: (id: string, element: HTMLElement) => {
                elements.current.set(id, element);
                dispatch({ type: 'enter', id });
            },
            leave: (id: string) => dispatch({ type: 'leave', id }),
            dismiss: () => dispatch({ type: 'dismiss' }),
        };
    }, []);

    return { shownId: state.shownId, displayedId, anchor, ...actions };
}

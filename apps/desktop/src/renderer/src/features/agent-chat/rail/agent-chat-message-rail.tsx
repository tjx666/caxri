import type { KeyboardEvent } from 'react';
import { memo, useMemo, useState } from 'react';

import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import type { AgentChatRailMark } from './agent-chat-rail-marks';
import {
    agentChatRailActiveTick,
    agentChatRailFocusStep,
    agentChatRailSampleIndices,
    isAgentChatMessageRailShown,
} from './agent-chat-rail-marks';
import { AgentChatRailPreviewCard } from './agent-chat-rail-preview-card';
import { useAgentChatRailCapacity } from './hooks/use-agent-chat-rail-capacity';
import { useAgentChatRailPreview } from './hooks/use-agent-chat-rail-preview';
import { useIsAgentChatRailGutterHovered } from './hooks/use-is-agent-chat-rail-gutter-hovered';

/**
 * One tick. Its props are plain values and stable handlers, so a patch that rebuilds the marks, or the preview card
 * moving to the next tick, re-renders only the ticks whose own props changed. The button keeps at least 6px of height
 * however many ticks share the rail, so each stays a target a pointer can hit; the visible bar inside it stays 2px.
 */
const RailTick = memo(
    ({
        id,
        isActive,
        isTabStop,
        position,
        preview,
        onEnter,
        onFocusTick,
        onJump,
        onLeave,
    }: {
        id: string;
        isActive: boolean;
        /**
         * The one tick Tab reaches; arrow keys move focus among the rest.
         */
        isTabStop: boolean;
        position: number;
        preview: string;
        /**
         * The pointer or focus reached the tick, so its preview card should open beside it.
         */
        onEnter: (id: string, element: HTMLElement) => void;
        onFocusTick: (position: number) => void;
        onJump: (id: string) => void;
        onLeave: (id: string) => void;
    }) => {
        const { t } = useTranslation();
        return (
            <button
                aria-current={isActive ? 'location' : undefined}
                aria-label={t('agentChat.rail.goToMessage', { preview })}
                className="group/tick flex h-2.5 min-h-1.5 w-5 shrink cursor-pointer items-center border-0 bg-transparent p-0 pl-1.5 focus-visible:outline focus-visible:outline-accent"
                data-agent-chat-rail-tick={id}
                tabIndex={isTabStop ? 0 : -1}
                type="button"
                onBlur={() => onLeave(id)}
                onClick={() => onJump(id)}
                onFocus={(event) => {
                    onFocusTick(position);
                    // A click focuses the tick too; only keyboard focus opens the card, so a clicked tick's card still
                    // closes once the pointer leaves it.
                    if (event.currentTarget.matches(':focus-visible'))
                        onEnter(id, event.currentTarget);
                }}
                onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') onEnter(id, event.currentTarget);
                }}
                onPointerLeave={(event) => {
                    // Keyboard focus still on the tick keeps its card open.
                    if (
                        event.pointerType === 'mouse' &&
                        !event.currentTarget.matches(':focus-visible')
                    )
                        onLeave(id);
                }}
            >
                <span
                    className={cn(
                        'block h-0.5 rounded-full transition-[width,background-color] motion-reduce:transition-none',
                        isActive
                            ? 'w-3 bg-foreground/70'
                            : 'w-2 bg-muted/35 group-hover/tick:w-3 group-hover/tick:bg-foreground/70 group-focus-visible/tick:w-3 group-focus-visible/tick:bg-foreground/70',
                    )}
                />
            </button>
        );
    },
);

/**
 * A quiet column of ticks at the Chat's left edge, one per user message, modeled on the Codex app's conversation rail.
 * It stays out of sight until the pointer reaches the Chat's left gutter or keyboard focus enters it, so a reader who
 * is not navigating sees only the transcript; its ticks stay translucent even then, and the tick for the message being
 * read is longer and brighter. Hovering one, or focusing it from the keyboard, opens its preview card
 * ({@link AgentChatRailPreviewCard}) and clicking scrolls there. A conversation with one message has nowhere to jump, so
 * the rail appears from the second; a narrow Chat's transcript then widens its left padding past the rail so content
 * never runs under the ticks, while a wide Chat's centering margin already clears them and its transcript stays put.
 * The rail is one Tab stop: ArrowUp and ArrowDown (Home, End) move among its ticks, and Enter jumps. Ticks shrink
 * together when a long conversation would overflow the view, down to a 6px target each; past that, or past
 * `MAX_AGENT_CHAT_RAIL_MARKS` messages, each tick stands for a stretch of the conversation, so the rail never scrolls.
 */
export function AgentChatMessageRail({
    activeIndex,
    hasEarlierHistory,
    marks,
    onJump,
}: {
    activeIndex: number;
    /**
     * True while older history is not loaded yet, so `marks` is not the whole conversation and the card must not claim
     * a position out of a total.
     */
    hasEarlierHistory: boolean;
    marks: readonly AgentChatRailMark[];
    onJump: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [rail, setRail] = useState<HTMLElement | null>(null);
    const capacity = useAgentChatRailCapacity(rail);
    const isInGutter = useIsAgentChatRailGutterHovered(rail);
    const indices = useMemo(
        () => agentChatRailSampleIndices(marks.length, capacity),
        [capacity, marks.length],
    );
    /**
     * The tick keyboard focus last moved to while inside the rail; outside it, Tab lands on the tick being read.
     */
    const [focusedTick, setFocusedTick] = useState<number>();
    const preview = useAgentChatRailPreview();
    if (!isAgentChatMessageRailShown(marks)) return null;
    const activeTick = agentChatRailActiveTick(indices, activeIndex);
    const tabStop =
        focusedTick !== undefined && focusedTick < indices.length
            ? focusedTick
            : activeTick === -1
              ? indices.length - 1
              : activeTick;
    const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
        if (event.key === 'Escape' && preview.shownId !== undefined) {
            event.preventDefault();
            preview.dismiss();
            return;
        }
        const next = agentChatRailFocusStep(tabStop, indices.length, event.key);
        if (next === undefined) return;
        event.preventDefault();
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    };
    const shownMark =
        preview.displayedId === undefined
            ? undefined
            : marks.find((mark) => mark.id === preview.displayedId);
    return (
        <nav
            aria-label={t('agentChat.rail.label')}
            className={cn(
                'absolute top-1/2 left-1 flex max-h-[calc(100%-6rem)] -translate-y-1/2 flex-col transition-opacity focus-within:opacity-100',
                !isInGutter && preview.shownId === undefined && 'opacity-0',
            )}
            data-agent-chat-message-rail=""
            ref={setRail}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedTick(undefined);
            }}
            onKeyDown={onKeyDown}
        >
            {indices.map((index, position) => {
                const mark = marks[index];
                return (
                    <RailTick
                        id={mark.id}
                        isActive={position === activeTick}
                        isTabStop={position === tabStop}
                        key={mark.id}
                        position={position}
                        preview={mark.preview}
                        onEnter={preview.enter}
                        onFocusTick={setFocusedTick}
                        onJump={onJump}
                        onLeave={preview.leave}
                    />
                );
            })}
            <AgentChatRailPreviewCard
                anchor={preview.anchor}
                isOpen={preview.shownId !== undefined && shownMark?.id === preview.shownId}
                mark={shownMark}
                position={shownMark ? marks.indexOf(shownMark) + 1 : 0}
                loadedCount={marks.length}
                total={hasEarlierHistory ? undefined : marks.length}
                onDismiss={preview.dismiss}
            />
        </nav>
    );
}

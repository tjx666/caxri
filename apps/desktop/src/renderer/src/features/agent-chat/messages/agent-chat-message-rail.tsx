import type { KeyboardEvent } from 'react';
import { memo, useMemo, useState } from 'react';

import { Tooltip } from '../../../components/ui/tooltip';
import { useTranslation } from '../../../i18n';
import { cn } from '../../../lib/utilities';
import { useAgentChatRailCapacity } from '../hooks/use-agent-chat-rail-capacity';
import type { AgentChatRailMark } from '../transcript/agent-chat-rail-marks';
import {
    agentChatRailActiveTick,
    agentChatRailFocusStep,
    agentChatRailSampleIndices,
    isAgentChatMessageRailShown,
} from '../transcript/agent-chat-rail-marks';

/**
 * One tick. Its props are plain values, so a patch that rebuilds the marks re-renders only the ticks whose message or
 * active state changed, not every tooltip on the rail. The button keeps at least 6px of height however many ticks share
 * the rail, so each stays a target a pointer can hit; the visible bar inside it stays 2px.
 */
const RailTick = memo(
    ({
        id,
        isActive,
        isTabStop,
        position,
        preview,
        onFocusTick,
        onJump,
    }: {
        id: string;
        isActive: boolean;
        /**
         * The one tick Tab reaches; arrow keys move focus among the rest.
         */
        isTabStop: boolean;
        position: number;
        preview: string;
        onFocusTick: (position: number) => void;
        onJump: (id: string) => void;
    }) => {
        const { t } = useTranslation();
        return (
            <Tooltip
                anchorMode="cursor"
                content={<span className="line-clamp-3 max-w-72 wrap-anywhere">{preview}</span>}
                side="right"
            >
                <button
                    aria-current={isActive ? 'location' : undefined}
                    aria-label={t('agentChat.rail.goToMessage', { preview })}
                    className="group/tick flex h-2.5 min-h-1.5 w-5 shrink cursor-pointer items-center border-0 bg-transparent p-0 pl-1.5 focus-visible:outline focus-visible:outline-accent"
                    tabIndex={isTabStop ? 0 : -1}
                    type="button"
                    onClick={() => onJump(id)}
                    onFocus={() => onFocusTick(position)}
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
            </Tooltip>
        );
    },
);

/**
 * A quiet column of ticks at the Chat's left edge, one per user message, modeled on the Codex app's conversation rail.
 * Ticks stay translucent so the rail recedes behind the transcript; the tick for the message being read is longer and
 * brighter. Hovering one, or focusing it from the keyboard, previews its message and clicking scrolls there. A
 * conversation with one message has nowhere to jump, so the rail appears from the second; the transcript then widens
 * its left padding past the rail so a narrow Chat's content never runs under the ticks. The rail is one Tab stop:
 * ArrowUp and ArrowDown (Home, End) move among its ticks, and Enter jumps. Ticks shrink together when a long
 * conversation would overflow the view, down to a 6px target each; past that, or past `MAX_AGENT_CHAT_RAIL_MARKS`
 * messages, each tick stands for a stretch of the conversation, so the rail never scrolls.
 */
export function AgentChatMessageRail({
    activeIndex,
    marks,
    onJump,
}: {
    activeIndex: number;
    marks: readonly AgentChatRailMark[];
    onJump: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [rail, setRail] = useState<HTMLElement | null>(null);
    const capacity = useAgentChatRailCapacity(rail);
    const indices = useMemo(
        () => agentChatRailSampleIndices(marks.length, capacity),
        [capacity, marks.length],
    );
    /**
     * The tick keyboard focus last moved to while inside the rail; outside it, Tab lands on the tick being read.
     */
    const [focusedTick, setFocusedTick] = useState<number>();
    if (!isAgentChatMessageRailShown(marks)) return null;
    const activeTick = agentChatRailActiveTick(indices, activeIndex);
    const tabStop =
        focusedTick !== undefined && focusedTick < indices.length
            ? focusedTick
            : activeTick === -1
              ? indices.length - 1
              : activeTick;
    const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
        const next = agentChatRailFocusStep(tabStop, indices.length, event.key);
        if (next === undefined) return;
        event.preventDefault();
        event.currentTarget.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    };
    return (
        <nav
            aria-label={t('agentChat.rail.label')}
            className="absolute top-1/2 left-1 flex max-h-[calc(100%-6rem)] -translate-y-1/2 flex-col"
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
                        onFocusTick={setFocusedTick}
                        onJump={onJump}
                    />
                );
            })}
        </nav>
    );
}

import { memo } from 'react';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import type { AgentChatRailMark } from './agent-chat-rail-marks';
import { isAgentChatMessageRailShown } from './agent-chat-rail-marks';

/**
 * One tick. Its props are plain values, so a patch that rebuilds the marks re-renders only the ticks whose message or
 * active state changed, not every tooltip on the rail.
 */
const RailTick = memo(
    ({
        id,
        isActive,
        preview,
        onJump,
    }: {
        id: string;
        isActive: boolean;
        preview: string;
        onJump: (id: string) => void;
    }) => (
        <Tooltip
            anchorMode="cursor"
            content={<span className="line-clamp-3 max-w-72 wrap-anywhere">{preview}</span>}
            hoverOnly
        >
            <button
                aria-current={isActive ? 'location' : undefined}
                aria-label={`Go to message: ${preview}`}
                className="group/tick flex h-2.5 min-h-0.5 w-5 shrink cursor-pointer items-center border-0 bg-transparent p-0 pl-1.5 focus-visible:outline focus-visible:outline-accent"
                type="button"
                onClick={() => onJump(id)}
            >
                <span
                    className={cn(
                        'block h-0.5 rounded-full transition-[width,background-color] duration-(--motion-overlay-enter) ease-(--motion-ease-enter) motion-reduce:transition-none',
                        isActive
                            ? 'w-3 bg-foreground/70'
                            : 'w-2 bg-muted/35 group-hover/tick:w-3 group-hover/tick:bg-foreground/70',
                    )}
                />
            </button>
        </Tooltip>
    ),
);

/**
 * A quiet column of ticks at the Chat's left edge, one per user message, modeled on the Codex app's conversation rail.
 * Ticks stay translucent so the rail recedes behind the transcript; the tick for the message being read is longer and
 * brighter. Hovering one previews its message and clicking scrolls there. A conversation with one message has nowhere
 * to jump, so the rail appears from the second; the transcript then widens its left padding past the rail so a narrow
 * Chat's content never runs under the ticks. Ticks shrink together when a long conversation would overflow the view;
 * past `MAX_AGENT_CHAT_RAIL_MARKS` messages each tick stands for a stretch of the conversation, so the rail never
 * scrolls.
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
    if (!isAgentChatMessageRailShown(marks)) return null;
    return (
        <nav
            aria-label="Messages"
            className="absolute top-1/2 left-1 flex max-h-[calc(100%-6rem)] -translate-y-1/2 flex-col"
            data-agent-chat-message-rail=""
        >
            {marks.map((mark, index) => (
                <RailTick
                    id={mark.id}
                    isActive={index === activeIndex}
                    key={mark.id}
                    preview={mark.preview}
                    onJump={onJump}
                />
            ))}
        </nav>
    );
}

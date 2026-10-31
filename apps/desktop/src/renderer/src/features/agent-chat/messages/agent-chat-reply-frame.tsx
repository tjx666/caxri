import type { ComponentProps, FocusEvent, ReactNode } from 'react';
import { useState } from 'react';

import { cn } from '../../../lib/utilities';
import { AGENT_CHAT_NAVIGABLE_REPLY_ATTRIBUTE } from './agent-chat-reply-navigation';

/**
 * A message with an action row that mounts only while the pointer is over the message or keyboard focus is inside it,
 * so a long transcript does not keep a Copy button, a tooltip, and a ticking time under every message, and a hidden row
 * is never a Tab stop. The row's height stays reserved, so revealing it never shifts the transcript. The hover state
 * lives here rather than in the message: the message text arrives as `children`, which React reuses unchanged when only
 * this frame re-renders. Agent replies and the user's own messages both use it.
 *
 * A message with actions is focusable from script only, so the keyboard reaches its actions without a Tab stop per
 * message: `Option+ArrowUp`/`Option+ArrowDown` in the transcript focus a message (`onAgentChatTranscriptKeyDown`),
 * which mounts the row, and Tab continues into it.
 */
export function AgentChatReplyFrame({
    actions,
    actionsClassName,
    children,
    className,
    isPinned = false,
    persistentActions,
    ...rest
}: Omit<ComponentProps<'div'>, 'children' | 'onBlur' | 'onFocus'> & {
    actions: ReactNode;
    /**
     * The action row's spacing, for a message laid out differently from a reply.
     */
    actionsClassName?: string;
    children: ReactNode;
    /**
     * Keeps the row mounted without hover or focus, while one of its actions is still running and shows a spinner.
     */
    isPinned?: boolean;
    /**
     * Ends the row and stays shown without hover or focus: a user message's version switcher, which must stay findable
     * once the message has earlier versions. A user message's row is end-aligned, so the hover actions that mount
     * before it never move it out from under the pointer on the way to a click.
     */
    persistentActions?: ReactNode;
}) {
    const [isHovered, setHovered] = useState(false);
    const [isFocusWithin, setFocusWithin] = useState(false);
    const onBlur = (event: FocusEvent<HTMLDivElement>) => {
        // Focus moving between elements inside the message keeps the row; leaving the message drops it.
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
    };
    return (
        <div
            {...rest}
            {...(actions !== null && { [AGENT_CHAT_NAVIGABLE_REPLY_ATTRIBUTE]: '', tabIndex: -1 })}
            className={cn(
                'rounded-sm outline-none focus-visible:outline focus-visible:outline-offset-4 focus-visible:outline-accent',
                className,
            )}
            onBlur={onBlur}
            onFocus={() => setFocusWithin(true)}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
        >
            {children}
            {(actions !== null || persistentActions) && (
                <div
                    className={cn('mt-0.5 flex h-6 items-center gap-1', actionsClassName)}
                    data-agent-chat-find-ignore=""
                >
                    {(isHovered || isFocusWithin || isPinned) && actions}
                    {persistentActions}
                </div>
            )}
        </div>
    );
}

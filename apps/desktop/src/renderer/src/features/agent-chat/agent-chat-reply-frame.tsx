import type { FocusEvent, ReactNode } from 'react';
import { useState } from 'react';

/**
 * A reply with an action row that mounts only while the pointer is over the reply or keyboard focus is inside it, so a
 * long transcript does not keep a Copy button, a tooltip, and a ticking time under every reply. The row's height stays
 * reserved, so revealing it never shifts the transcript. The hover state lives here rather than in the reply: the reply
 * text arrives as `children`, which React reuses unchanged when only this frame re-renders.
 */
export function AgentChatReplyFrame({
    actions,
    children,
}: {
    actions: ReactNode;
    children: ReactNode;
}) {
    const [isHovered, setHovered] = useState(false);
    const [isFocusWithin, setFocusWithin] = useState(false);
    const onBlur = (event: FocusEvent<HTMLDivElement>) => {
        // Focus moving between elements inside the reply keeps the row; leaving the reply drops it.
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
    };
    return (
        <div
            data-agent-chat-reply=""
            onBlur={onBlur}
            onFocus={() => setFocusWithin(true)}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
        >
            {children}
            {actions !== null && (
                <div className="mt-0.5 flex h-6 items-center gap-1" data-agent-chat-find-ignore="">
                    {(isHovered || isFocusWithin) && actions}
                </div>
            )}
        </div>
    );
}

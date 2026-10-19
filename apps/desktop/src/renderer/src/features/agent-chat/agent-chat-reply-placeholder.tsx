/**
 * Holds the reply's place while a running turn has shown nothing yet, as the Claude and ChatGPT apps do: three muted
 * dots where the reply's first line will start, so the prompt is not left above a blank page while the Agent thinks. It
 * names no activity of its own; the composer's status line already says what the turn is doing and owns the live
 * region, so the dots stay hidden from assistive technology.
 */
export function AgentChatReplyPlaceholder() {
    return (
        <div
            aria-hidden="true"
            className="flex h-6 items-center gap-1 text-muted"
            data-agent-chat-reply-placeholder=""
        >
            {[0, 1, 2].map((index) => (
                <span
                    className="reply-placeholder-dot size-1.5 rounded-full bg-current"
                    key={index}
                />
            ))}
        </div>
    );
}

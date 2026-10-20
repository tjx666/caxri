import { useLoadingStyle, WorkingFigure } from './loading';

/**
 * Holds the reply's place while a running turn has shown nothing yet, as the Claude and ChatGPT apps do: a small figure
 * where the reply's first line will start (`agentChat.workingIndicator`: Buddy thinking by default, or dots, a caret, a
 * braille spinner, or an orbit), so the prompt is not left above a blank page while the Agent thinks. It names no
 * activity of its own; the composer's status line already says what the turn is doing and owns the live region, so the
 * figure stays hidden from assistive technology.
 */
export function AgentChatReplyPlaceholder({ turnId }: { turnId: string | undefined }) {
    const { workingIndicator } = useLoadingStyle();
    return (
        <div
            aria-hidden="true"
            className="flex h-6 items-center text-muted"
            data-agent-chat-reply-placeholder=""
        >
            <WorkingFigure indicator={workingIndicator} turnId={turnId} />
        </div>
    );
}

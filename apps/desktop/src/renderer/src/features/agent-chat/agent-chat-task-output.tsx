import { ArrowDown } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { useAgentChatScroll } from './hooks/use-agent-chat-scroll';

/**
 * A background shell's output tail in a monospaced block that follows new output while the user reads the end and stays
 * put once they scroll up, like the Chat timeline. It says when the output is only the latest part, and when the
 * provider stopped streaming it (the command may still run), so a quiet block is never mistaken for an idle command.
 */
export function AgentChatTaskOutput({
    isOutputCapped,
    isRunning,
    isTruncated,
    output,
    revision,
}: {
    isOutputCapped: boolean;
    isRunning: boolean;
    isTruncated: boolean;
    output: string | undefined;
    revision: number;
}) {
    const { scrollReference, contentReference, isFollowing, onScroll, jumpToLatest } =
        useAgentChatScroll(revision);
    const text = output?.replace(/\n+$/u, '') ?? '';
    return (
        <div className="relative flex h-full min-h-0 flex-col">
            {(isOutputCapped || isTruncated) && (
                <div className="flex shrink-0 flex-col gap-0.5 border-b border-border px-4 py-1.5 text-[11px] leading-4 text-muted">
                    {isTruncated && <span>Showing the latest output</span>}
                    {isOutputCapped && (
                        <span className="text-warning">
                            Output stopped streaming; the command may still be running
                        </span>
                    )}
                </div>
            )}
            <div className="min-h-0 flex-1 overflow-auto" ref={scrollReference} onScroll={onScroll}>
                <div ref={contentReference}>
                    {text ? (
                        <pre className="m-0 px-4 py-3 font-mono text-[11px] leading-5 wrap-anywhere whitespace-pre-wrap text-foreground">
                            {text}
                        </pre>
                    ) : (
                        <p className="m-0 px-4 py-3 text-[12px] text-muted">
                            {isRunning ? 'No output yet' : 'No output'}
                        </p>
                    )}
                </div>
            </div>
            {!isFollowing && (
                <Button
                    className="absolute bottom-2 left-1/2 -translate-x-1/2 shadow-md"
                    size="sm"
                    variant="secondary"
                    onClick={jumpToLatest}
                >
                    <ArrowDown className="size-3.5" />
                    Jump to latest
                </Button>
            )}
        </div>
    );
}

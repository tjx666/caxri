import { CodeView } from '../../components/markdown/code-view';
import { AgentChatJumpToLatest } from './agent-chat-jump-to-latest';
import { useAgentChatScroll } from './hooks/use-agent-chat-scroll';

/**
 * A background shell's output tail in the shared code block (soft-wrap toggle, Copy) that follows new output while the
 * user reads the end and stays put once they scroll up, like the Chat timeline. It is colored only once the shell ends,
 * so a fast-streaming tail is not re-colorized on every chunk. It says when the output is only the latest part, and
 * when the provider stopped streaming it (the command may still run), so a quiet block is never mistaken for an idle
 * command.
 */
export function AgentChatTaskOutput({
    command,
    isOutputCapped,
    isRunning,
    isTruncated,
    output,
    revision,
}: {
    /**
     * The command line, when the tab is titled by the Agent's description of it.
     */
    command?: string | undefined;
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
            {/* Pinned above the scroller so following the output's end never scrolls the command out of view. */}
            {command && (
                <pre className="m-0 max-h-24 shrink-0 overflow-y-auto border-b border-border px-4 py-2 font-mono text-[11px] leading-5 wrap-anywhere whitespace-pre-wrap text-muted">
                    $ {command}
                </pre>
            )}
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
            <div
                className="min-h-0 flex-1 overflow-auto outline-none"
                ref={scrollReference}
                tabIndex={-1}
                onScroll={onScroll}
            >
                <div ref={contentReference}>
                    {text ? (
                        <div className="px-4 py-3">
                            <CodeView
                                code={text}
                                isPaintable={!isRunning}
                                label="Output"
                                language="shell"
                            />
                        </div>
                    ) : (
                        <p className="m-0 px-4 py-3 text-[12px] text-muted">
                            {isRunning ? 'No output yet' : 'No output'}
                        </p>
                    )}
                </div>
            </div>
            <AgentChatJumpToLatest
                focusTarget={scrollReference}
                isFollowing={isFollowing}
                onJump={jumpToLatest}
            />
        </div>
    );
}

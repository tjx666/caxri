import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { useTerminal } from '../../stores/selectors';
import { TerminalPane } from '../terminal/terminal-pane';
import { useAgentCommanderStore } from './commander-client';
import type { AgentCommanderStatus } from './use-agent-commander';

/**
 * The Commander's own Terminal, rendered by the ordinary Terminal pane against the Commander-scoped snapshot. It mounts
 * only once `commander.ensure` resolved, because Main admits `terminal.*` for this Terminal only after it saw that
 * reply.
 */
export function CommanderTerminal({
    onRetry,
    status,
}: {
    onRetry: () => void;
    status: AgentCommanderStatus;
}) {
    const terminalId = useAgentCommanderStore((state) => state.identity?.terminalId);
    const terminal = useTerminal(terminalId ?? '');
    if (status.kind === 'error')
        return (
            <div
                role="alert"
                className="commander-terminal-status flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted"
            >
                <span className="text-foreground">Agent Commander could not start.</span>
                <span className="max-w-[460px] text-xs">{status.message}</span>
                <Button size="sm" variant="secondary" onClick={onRetry}>
                    Retry
                </Button>
            </div>
        );
    if (!terminal || status.kind === 'loading')
        return (
            <div className="commander-terminal-status flex h-full flex-col items-center justify-center gap-3 p-6 text-muted">
                <Spinner />
                <span>Starting Agent Commander…</span>
            </div>
        );
    return (
        <TerminalPane
            active
            ariaLabel={`Agent Commander: ${terminal.title}`}
            isPaneVisible
            terminalId={terminal.id}
        />
    );
}

import type { TerminalRecord } from '@shared/types';
import { capitalize } from 'es-toolkit';
import { CircleDot } from 'lucide-react';

import { resolveAgentIcon } from '../../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../../icons/agents/agent-identity-icon';
import { cn } from '../../../../lib/utilities';
import { useSelectedSession, useSessionTerminals } from '../../../../stores/selectors';

function processStateLabel(state: TerminalRecord['lastProcessState']): string {
    return capitalize(state);
}

const terminalStateColor: Record<TerminalRecord['lastProcessState'], string> = {
    running: 'text-success',
    starting: 'text-warning',
    stopped: 'text-muted',
    dead: 'text-danger',
    failed: 'text-danger',
    /**
     * Same treatment as `dead`: an interrupted Terminal is restoring in the background, not a live process.
     */
    interrupted: 'text-danger',
};

/**
 * Scoped to the selected Session's Terminals so another Session's Agents never leak in here.
 */
export function TerminalInfoPanel() {
    const session = useSelectedSession();
    const terminals = useSessionTerminals();
    if (!session)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                Create a Session to inspect Terminals.
            </div>
        );
    if (terminals.length === 0)
        return (
            <div className="empty-panel px-3 py-4 text-center text-muted">
                No Terminals in this Session.
            </div>
        );

    return (
        <div className="inspector-content terminal-info-panel min-h-0 flex-1 overflow-auto p-2">
            {terminals.map((terminal) => {
                const isPrimary = terminal.id === session.primaryAgentTerminalId;
                return (
                    <section
                        key={terminal.id}
                        className="terminal-info-card mb-2 rounded-md border border-border bg-background p-3"
                        data-terminal-info-id={terminal.id}
                    >
                        <div className="terminal-info-title flex items-center gap-2">
                            <AgentIdentityIcon identity={terminal.kind} size={15} />
                            <strong className="min-w-0 flex-1 truncate font-semibold">
                                {terminal.title}
                            </strong>
                            {isPrimary && (
                                <span className="flex-none rounded bg-elevated px-1 text-[10px] text-muted">
                                    Title source
                                </span>
                            )}
                        </div>
                        <dl className="my-2 grid grid-cols-[64px_minmax(0,1fr)] gap-1 text-[11px]">
                            <dt className="text-muted">Type</dt>
                            <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                {resolveAgentIcon(terminal.kind).label}
                            </dd>
                            <dt className="text-muted">Status</dt>
                            <dd
                                className={cn(
                                    `terminal-state terminal-state-${terminal.lastProcessState}`,
                                    'flex items-center gap-1',
                                    terminalStateColor[terminal.lastProcessState],
                                )}
                            >
                                <CircleDot size={12} />
                                {processStateLabel(terminal.lastProcessState)}
                            </dd>
                            {terminal.processId && (
                                <>
                                    <dt className="text-muted">PID</dt>
                                    <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                        {terminal.processId}
                                    </dd>
                                </>
                            )}
                            <dt className="text-muted">Directory</dt>
                            <dd
                                className="m-0 min-w-0 [overflow-wrap:anywhere]"
                                title={terminal.cwd}
                            >
                                {terminal.cwd}
                            </dd>
                            {terminal.agentSessionId && (
                                <>
                                    <dt className="text-muted">Agent Session</dt>
                                    <dd className="m-0 min-w-0 [overflow-wrap:anywhere]">
                                        {terminal.agentSessionId}
                                    </dd>
                                </>
                            )}
                        </dl>
                    </section>
                );
            })}
        </div>
    );
}

import type { TerminalRecord } from '@shared/types';
import { CircleDot } from 'lucide-react';

import { resolveAgentIcon } from '../../../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../../../icons/agents/agent-identity-icon';
import { cn } from '../../../../lib/utilities';
import { useSelectedSession, useSessionTerminals } from '../../../../stores/selectors';

function processStateLabel(state: TerminalRecord['lastProcessState']): string {
    return state[0].toUpperCase() + state.slice(1);
}

const terminalStateColor: Record<TerminalRecord['lastProcessState'], string> = {
    running: 'text-success',
    starting: 'text-warning',
    stopped: 'text-muted',
    dead: 'text-danger',
    failed: 'text-danger',
    /**
    Same treatment as `dead`: an interrupted Terminal is restoring in the background, not a live process.
     */
    interrupted: 'text-danger',
};

/**
Scoped to the selected Session's Terminals so another Session's Agents never leak in here.
 */
export function TerminalInfoPanel() {
    const session = useSelectedSession();
    const terminals = useSessionTerminals();
    if (!session)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
                Create a Session to inspect Terminals.
            </div>
        );
    if (terminals.length === 0)
        return (
            <div className="empty-panel py-4 px-3 text-muted text-center">
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
                        className="terminal-info-card p-3 mb-2 border border-border rounded-md bg-background"
                        data-terminal-info-id={terminal.id}
                    >
                        <div className="terminal-info-title flex items-center gap-2">
                            <AgentIdentityIcon identity={terminal.kind} size={15} />
                            <strong className="min-w-0 flex-1 truncate font-semibold">
                                {terminal.title}
                            </strong>
                            {isPrimary && (
                                <span className="flex-none px-1 rounded bg-elevated text-muted text-[10px]">
                                    Title source
                                </span>
                            )}
                        </div>
                        <dl className="grid grid-cols-[64px_minmax(0,1fr)] gap-1 my-2 text-[11px]">
                            <dt className="text-muted">Type</dt>
                            <dd className="min-w-0 m-0 [overflow-wrap:anywhere]">
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
                                    <dd className="min-w-0 m-0 [overflow-wrap:anywhere]">
                                        {terminal.processId}
                                    </dd>
                                </>
                            )}
                            <dt className="text-muted">Directory</dt>
                            <dd
                                className="min-w-0 m-0 [overflow-wrap:anywhere]"
                                title={terminal.cwd}
                            >
                                {terminal.cwd}
                            </dd>
                            {terminal.agentSessionId && (
                                <>
                                    <dt className="text-muted">Agent Session</dt>
                                    <dd className="min-w-0 m-0 [overflow-wrap:anywhere]">
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

import { CircleDot } from 'lucide-react';

import type { SessionRecord, TerminalRecord } from '@shared/types';

import { AgentIdentityIcon } from '../agent-icons/AgentIdentityIcon';
import { resolveAgentIcon } from '../agent-icons/agent-icon-registry';

function processStateLabel(state: TerminalRecord['lastProcessState']): string {
    return state[0].toUpperCase() + state.slice(1);
}

export function TerminalInfoPanel({
    session,
    terminals,
}: {
    session?: SessionRecord;
    terminals: TerminalRecord[];
}) {
    if (!session) return <div className="empty-panel">Create a Session to inspect Terminals.</div>;
    if (terminals.length === 0)
        return <div className="empty-panel">No Terminals in this Session.</div>;

    return (
        <div className="inspector-content terminal-info-panel">
            {terminals.map((terminal) => {
                const primary = terminal.id === session.primaryAgentTerminalId;
                return (
                    <section
                        key={terminal.id}
                        className="terminal-info-card"
                        data-terminal-info-id={terminal.id}
                    >
                        <div className="terminal-info-title">
                            <AgentIdentityIcon identity={terminal.kind} size={15} />
                            <strong>{terminal.title}</strong>
                            {primary && <span>Title source</span>}
                        </div>
                        <dl>
                            <dt>Type</dt>
                            <dd>{resolveAgentIcon(terminal.kind).label}</dd>
                            <dt>Status</dt>
                            <dd
                                className={`terminal-state terminal-state-${terminal.lastProcessState}`}
                            >
                                <CircleDot size={12} />
                                {processStateLabel(terminal.lastProcessState)}
                            </dd>
                            {terminal.processId && (
                                <>
                                    <dt>PID</dt>
                                    <dd>{terminal.processId}</dd>
                                </>
                            )}
                            <dt>Directory</dt>
                            <dd title={terminal.cwd}>{terminal.cwd}</dd>
                            {terminal.agentSessionId && (
                                <>
                                    <dt>Agent Session</dt>
                                    <dd>{terminal.agentSessionId}</dd>
                                </>
                            )}
                        </dl>
                    </section>
                );
            })}
        </div>
    );
}

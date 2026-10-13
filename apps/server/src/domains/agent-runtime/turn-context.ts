import { isChatTerminal } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
import { AGENT_SESSION_DISCOVERY_CONTEXT } from '../agents';
import type { CaxriDatabase } from '../db';
import { agentCommanderTerminal } from '../db';

/**
 * Supplies the context a Terminal Agent's first `turnStarted` hook adds to its prompt, once per launch.
 *
 * Only Claude and Codex read `additionalContext` from `UserPromptSubmit`. An Agent Chat gets the same text through its
 * provider's instructions, and the Agent Commander through its workspace instructions, so both are skipped here.
 */
export class AgentTurnContext {
    /**
     * The launch each Terminal last received the context in. Keyed by Terminal so a relaunch delivers it again, and the
     * map stays bounded by live Terminals.
     */
    private readonly delivered = new Map<string, string>();

    constructor(private readonly database: CaxriDatabase) {}

    for(signal: AgentLifecycleSignal): string | undefined {
        if (signal.phase !== 'turnStarted' || signal.agentId) return undefined;
        if (signal.provider !== 'claude' && signal.provider !== 'codex') return undefined;
        if (this.delivered.get(signal.terminalId) === signal.launchId) return undefined;
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal || isChatTerminal(terminal)) return undefined;
        if (agentCommanderTerminal(this.database)?.terminalId === terminal.id) return undefined;
        this.delivered.set(signal.terminalId, signal.launchId);
        return AGENT_SESSION_DISCOVERY_CONTEXT;
    }

    forget(terminalId: string): void {
        this.delivered.delete(terminalId);
    }
}

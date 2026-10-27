import { agentSessionInstructions, isChatTerminal } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';
import { caxriBotTerminal } from '../db';

/**
 * Supplies the context a Terminal Agent's first `turnStarted` hook adds to its prompt, once per launch.
 *
 * The text is the current `agents.sessionInstructions`, read when the turn starts so an edit reaches the next launch; a
 * cleared setting adds nothing. Only Claude and Codex read `additionalContext` from `UserPromptSubmit`. An Agent Chat
 * gets the same text through its provider's instructions, and Caxri Bot through its workspace instructions, so both are
 * skipped here.
 */
export class AgentTurnContext {
    /**
     * The launch each Terminal last received the context in. Keyed by Terminal so a relaunch delivers it again, and the
     * map stays bounded by live Terminals.
     */
    private readonly delivered = new Map<string, string>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly instructions: () => string | null,
    ) {}

    for(signal: AgentLifecycleSignal): string | undefined {
        if (signal.phase !== 'turnStarted' || signal.agentId) return undefined;
        if (signal.provider !== 'claude' && signal.provider !== 'codex') return undefined;
        if (this.delivered.get(signal.terminalId) === signal.launchId) return undefined;
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal || isChatTerminal(terminal)) return undefined;
        if (caxriBotTerminal(this.database)?.terminalId === terminal.id) return undefined;
        this.delivered.set(signal.terminalId, signal.launchId);
        return agentSessionInstructions(this.instructions());
    }

    forget(terminalId: string): void {
        this.delivered.delete(terminalId);
    }
}

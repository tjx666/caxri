import type { AgentSessionInstructionSettings, AppLocale } from '@caxri/protocol';
import { agentSessionInstructions, isChatTerminal } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
import type { CaxriDatabase } from '../db';
import { caxriBotTerminal } from '../db';

/**
 * Supplies the context a Terminal Agent's `turnStarted` hook adds to its prompt, once per provider conversation.
 *
 * The text follows the current `agents.sessionInstructions.*` settings, read when the turn starts so an edit reaches
 * the next delivery; turning both off adds nothing. Only Claude and Codex read `additionalContext` from
 * `UserPromptSubmit`. An Agent Chat gets the same text through its provider's instructions, and Caxri Bot through its
 * workspace instructions, so both are skipped here.
 *
 * Hook context lives in the conversation, not the process, so a launch alone is too coarse: `/clear` (Codex `/new`)
 * starts a new provider session in the same PTY, and a compaction summarizes the context away. Both used to leave the
 * rest of the launch without the instructions (issue #4058), so delivery is keyed by launch and provider session, and a
 * main-agent compaction makes the next turn deliver again.
 */
export class AgentTurnContext {
    /**
     * The launch and provider session each Terminal last received the context in. Keyed by Terminal so a relaunch or a
     * new provider session delivers it again, and the map stays bounded by live Terminals.
     */
    private readonly delivered = new Map<string, string>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly instructions: () => AgentSessionInstructionSettings,
        /**
         * Caxri's interface language, named after the instructions so a delegated task file reads in it.
         */
        private readonly displayLocale?: () => AppLocale,
    ) {}

    /**
     * Sees every authenticated signal, including ones later kept out of Session state: a Server-initiated keep-alive
     * compaction is absorbed there yet still summarizes the delivered context away.
     */
    observe(signal: AgentLifecycleSignal): void {
        if (signal.phase === 'compactionFinished' && !signal.agentId)
            this.delivered.delete(signal.terminalId);
    }

    for(signal: AgentLifecycleSignal): string | undefined {
        if (signal.phase !== 'turnStarted' || signal.agentId) return undefined;
        if (signal.provider !== 'claude' && signal.provider !== 'codex') return undefined;
        const key = `${signal.launchId}\u{0}${signal.agentSessionId ?? ''}`;
        if (this.delivered.get(signal.terminalId) === key) return undefined;
        const terminal = this.database.getTerminal(signal.terminalId);
        if (!terminal || isChatTerminal(terminal)) return undefined;
        if (caxriBotTerminal(this.database)?.terminalId === terminal.id) return undefined;
        this.delivered.set(signal.terminalId, key);
        return agentSessionInstructions(this.instructions(), this.displayLocale?.());
    }

    forget(terminalId: string): void {
        this.delivered.delete(terminalId);
    }
}

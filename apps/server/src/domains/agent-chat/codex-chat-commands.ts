import type { AgentChatSnapshot, AgentChatTurn } from '@caxri/protocol';
import { AGENT_CHAT_GOAL_COMMAND, CaxriError, parseAgentChatGoalArguments } from '@caxri/protocol';

import type { AgentChatSessionHost, ChatLifecycleEvent } from './chat-provider';
import { ChatTurnInterruption } from './chat-turn-interruption';
import { TURN_REQUEST_TIMEOUT_MS } from './codex-delivery-check';
import type { CodexGoals } from './codex-goals';
import type { JsonRpcConnection } from './json-rpc-connection';

/**
 * The compact RPC answers before its turn starts, so intent stays armed until that exact turn begins.
 */
export class CodexChatCommands {
    private isCompactionPending = false;
    private compactionTurnId: string | undefined;
    private usageBeforeCompaction: AgentChatSnapshot['usage'];
    private isContextCompaction = false;
    private readonly userInterruption = new ChatTurnInterruption();

    constructor(
        private readonly host: Pick<
            AgentChatSessionHost,
            'apply' | 'lifecycle' | 'read' | 'turnRequestTimeoutMs'
        >,
        private readonly goals: Pick<CodexGoals, 'change'>,
        private readonly connection: () => JsonRpcConnection,
        private readonly threadId: () => string | undefined,
        private readonly closeProcess: () => Promise<void>,
    ) {}

    beginTurn(turnId: string): Pick<ChatLifecycleEvent, 'activity'> {
        this.userInterruption.clear();
        this.compactionTurnId = this.isCompactionPending ? turnId : undefined;
        this.isCompactionPending = false;
        return this.compactionTurnId ? { activity: 'maintenance' } : {};
    }

    finishTurn(turnId: string): Pick<ChatLifecycleEvent, 'activity'> {
        this.userInterruption.clear(turnId);
        if (this.compactionTurnId !== turnId) return {};
        this.compactionTurnId = undefined;
        return { activity: 'maintenance' };
    }

    onCompaction(isStarted: boolean): boolean {
        const snapshot = this.host.read();
        if (isStarted) {
            if (!this.isContextCompaction) this.usageBeforeCompaction = snapshot.usage;
            this.isContextCompaction = true;
        } else {
            if (
                this.isContextCompaction &&
                snapshot.usage &&
                snapshot.usage === this.usageBeforeCompaction
            )
                this.host.apply([{ op: 'state', state: { usage: null } }]);
            this.isContextCompaction = false;
            this.usageBeforeCompaction = undefined;
        }
        return !isStarted || snapshot.operation !== 'compacting';
    }

    requestInterrupt(turnId: string): () => void {
        return this.userInterruption.request(turnId);
    }

    interruptionReason(turnId: string | undefined): AgentChatTurn['interruptionReason'] {
        return this.userInterruption.reason(turnId);
    }

    clear(): void {
        this.userInterruption.clear();
        this.isCompactionPending = false;
        this.compactionTurnId = undefined;
        this.usageBeforeCompaction = undefined;
        this.isContextCompaction = false;
    }

    async run(name: string, arguments_?: string): Promise<void> {
        const connection = this.connection();
        if (name === AGENT_CHAT_GOAL_COMMAND) {
            const change = parseAgentChatGoalArguments(arguments_);
            if (!change) throw new CaxriError('VALIDATION', 'Describe the goal after /goal');
            await this.goals.change(connection, change);
            return;
        }
        if (name !== 'compact')
            throw new CaxriError('VALIDATION', `/${name} is not available in Codex Chat`);
        const snapshot = this.host.read();
        if (snapshot.activeTurnId || snapshot.operation === 'compacting')
            throw new CaxriError(
                'CONFLICT',
                'Wait for the current turn to finish before compacting',
            );
        this.isCompactionPending = true;
        this.isContextCompaction = true;
        this.usageBeforeCompaction = snapshot.usage;
        // Keep input queued during the gap between the RPC response and the provider's turn notification.
        this.host.apply([{ op: 'state', state: { operation: 'compacting' } }]);
        this.host.lifecycle({ phase: 'compactionStarted' });
        try {
            await connection.request(
                'thread/compact/start',
                { threadId: this.threadId() },
                this.host.turnRequestTimeoutMs ?? TURN_REQUEST_TIMEOUT_MS,
            );
        } catch (error) {
            try {
                // An ambiguous compact cannot remain armed and misclassify a later user turn. Retire its owned process.
                if (error instanceof CaxriError && error.code === 'TIMEOUT')
                    await this.closeProcess();
            } finally {
                this.clear();
                this.host.apply([{ op: 'state', state: { operation: null } }]);
                this.host.lifecycle({ phase: 'compactionFinished' });
            }
            throw error;
        }
    }
}

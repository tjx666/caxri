import type { AgentChatGoal, AgentChatGoalChange } from '@caxri/protocol';
import {
    agentChatGoalStatusSchema,
    CaxriError,
    MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH,
} from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';
import type { AgentChatSessionHost } from './chat-provider';
import type { JsonRpcConnection } from './json-rpc-connection';

const GOAL_REQUEST_TIMEOUT_MS = 10_000;
/**
 * How long Stop waits for its goal pause before interrupting anyway, so a slow Codex cannot hold the turn running.
 */
const INTERRUPT_PAUSE_TIMEOUT_MS = 2000;

function nonnegativeInteger(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Maps a Codex `ThreadGoal`. `updatedAt` is when Server Core received it rather than Codex's own whole-second
 * `updatedAt`: a Client adds the running turn's time since then, and Codex reports `timeUsedSeconds` as of the moment
 * it sends.
 */
function mapCodexGoal(raw: unknown, receivedAt = Date.now()): AgentChatGoal | undefined {
    if (!isRecord(raw)) return undefined;
    const status = agentChatGoalStatusSchema.safeParse(raw.status);
    if (!status.success) return undefined;
    const tokenBudget = nonnegativeInteger(raw.tokenBudget);
    return {
        objective: clip(stringField(raw.objective) ?? '', MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH),
        status: status.data,
        tokensUsed: nonnegativeInteger(raw.tokensUsed),
        ...(tokenBudget > 0 && { tokenBudget }),
        timeUsedSeconds: nonnegativeInteger(raw.timeUsedSeconds),
        updatedAt: receivedAt,
    };
}

/**
 * A Codex thread's goal (`thread/goal/*`). Codex owns the goal and starts each turn that pursues it on its own, so this
 * only forwards the user's changes and mirrors what Codex reports into the snapshot's `goal`.
 */
export class CodexGoals {
    constructor(
        private readonly host: Pick<AgentChatSessionHost, 'apply' | 'read'>,
        private readonly threadId: () => string | undefined,
    ) {}

    private async set(
        connection: JsonRpcConnection,
        fields: { objective?: string; status: 'active' | 'paused' },
        timeoutMs = GOAL_REQUEST_TIMEOUT_MS,
    ): Promise<void> {
        const result = await connection.request(
            'thread/goal/set',
            { threadId: this.threadId(), origin: 'user', ...fields },
            timeoutMs,
        );
        // The response carries the goal before `thread/goal/updated` does, so the row changes as the request settles.
        const goal = isRecord(result) ? mapCodexGoal(result.goal) : undefined;
        if (goal) this.host.apply([{ op: 'state', state: { goal } }]);
    }

    private async clear(connection: JsonRpcConnection): Promise<void> {
        await connection.request(
            'thread/goal/clear',
            { threadId: this.threadId(), origin: 'user' },
            GOAL_REQUEST_TIMEOUT_MS,
        );
        this.host.apply([{ op: 'state', state: { goal: null } }]);
    }

    /**
     * Puts back the goal a failed replacement cleared, so the user keeps it rather than losing both. Best effort: the
     * goal starts its time and tokens over, and a failure here leaves the replacement's error to report.
     */
    private async restore(connection: JsonRpcConnection, goal: AgentChatGoal): Promise<void> {
        try {
            await this.set(connection, {
                objective: goal.objective,
                status: goal.status === 'active' ? 'active' : 'paused',
            });
        } catch {
            // The replacement's error already tells the user the goal did not change as asked.
        }
    }

    /**
     * Applies a `thread/goal/updated` or `thread/goal/cleared` notification for this thread.
     */
    onNotification(method: string, parameters: Record<string, unknown>): void {
        if (method === 'thread/goal/cleared') {
            this.host.apply([{ op: 'state', state: { goal: null } }]);
            return;
        }
        if (method !== 'thread/goal/updated') return;
        const goal = mapCodexGoal(parameters.goal);
        if (goal) this.host.apply([{ op: 'state', state: { goal } }]);
    }

    /**
     * Reads the goal of an opened thread. Codex also pushes it after `thread/resume`, but a history replay resets the
     * projection, so the read after it is the one that sticks. Best effort: an older Codex without goals keeps none.
     */
    async load(connection: JsonRpcConnection): Promise<void> {
        try {
            const result = await connection.request(
                'thread/goal/get',
                { threadId: this.threadId() },
                GOAL_REQUEST_TIMEOUT_MS,
            );
            const goal = isRecord(result) ? mapCodexGoal(result.goal) : undefined;
            this.host.apply([{ op: 'state', state: { goal: goal ?? null } }]);
        } catch {
            // A Codex without goals, or with the feature turned off, has none to show.
        }
    }

    /**
     * Performs a `/goal` change. A new objective replaces a goal that is not complete by clearing it first, because
     * setting an objective on an existing goal edits it and keeps its time and tokens. Every change carries `origin:
     * "user"`, which Codex records as the user's authorization for the goal.
     */
    async change(connection: JsonRpcConnection, change: AgentChatGoalChange): Promise<void> {
        const current = this.host.read().goal;
        switch (change.action) {
            case 'set': {
                if (change.objective.length > MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH)
                    throw new CaxriError(
                        'VALIDATION',
                        `Shorten the goal to ${MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH.toLocaleString('en-US')} characters or fewer`,
                    );
                if (current) await this.clear(connection);
                try {
                    await this.set(connection, { objective: change.objective, status: 'active' });
                } catch (error) {
                    if (current) await this.restore(connection, current);
                    throw error;
                }
                return;
            }
            case 'pause':
            case 'resume': {
                if (!current) throw new CaxriError('VALIDATION', 'This Chat has no goal');
                await this.set(connection, {
                    status: change.action === 'pause' ? 'paused' : 'active',
                });
                return;
            }
            case 'clear': {
                await this.clear(connection);
                return;
            }
        }
    }

    /**
     * Pauses an active goal before the user's Stop interrupts its turn. Codex starts the next turn for an active goal
     * as soon as the thread goes idle, so stopping without pausing would only end the current turn, as the Codex CLI
     * does.
     */
    async pauseForInterrupt(connection: JsonRpcConnection): Promise<void> {
        if (this.host.read().goal?.status !== 'active') return;
        try {
            await this.set(connection, { status: 'paused' }, INTERRUPT_PAUSE_TIMEOUT_MS);
        } catch {
            // The interrupt still goes out; at worst Codex continues the goal as it would have without the pause.
        }
    }
}

import { setTimeout as delay } from 'node:timers/promises';

import type {
    AgentChatGoal,
    AgentChatGoalReply,
    AgentChatItem,
    AgentChatSnapshot,
    AgentChatTurn,
} from '@caxri/protocol';
import {
    AGENT_CHAT_GOAL_COMMAND,
    agentChatGoalElapsedSeconds,
    MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH,
    MAX_AGENT_CHAT_GOAL_REASON_LENGTH,
    parseAgentChatGoalArguments,
    parseAgentChatGoalReply,
} from '@caxri/protocol';

import { clip, isRecord, stringField } from '../chat-items';
import type { AgentChatSessionHost } from '../chat-provider';
import { applyClaudeFeedback } from '../providers/claude/system-notices';

type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * Reads of the transcript before a goal that ended without a readable outcome is cleared.
 */
const OUTCOME_READ_ATTEMPTS = 3;

/**
 * The warning Claude Code prints when it drops the goal after an unrecoverable error, such as a full context window
 * (verified with Claude Code 2.1.304).
 */
const ERROR_CLEARED_PREFIX = 'Goal cleared after an unrecoverable error';

/**
 * What a notice says about the goal: `null` when it dropped the goal (a clear, `No goal set`, or the error warning),
 * the `/goal` reply when it set or reported one, and `undefined` when it says nothing. Shared by the live Chat and the
 * history replay so both read the same replies.
 */
export function claudeGoalNotice(notice: Notice): AgentChatGoalReply | null | undefined {
    if (notice.kind === 'warning' && notice.message?.startsWith(ERROR_CLEARED_PREFIX)) return null;
    const reply = parseAgentChatGoalReply(notice);
    if (!reply) return undefined;
    return reply.action === 'cleared' || reply.action === 'none' ? null : reply;
}

/**
 * How a Claude Code goal ended, read from the `goal_status` attachment its Stop hook writes when the evaluator settles
 * the goal (verified with Claude Code 2.1.312): `met: true` when the condition held, `failed: true` when it judged the
 * condition impossible. Both carry the evaluator's `reason` and the goal's `iterations`, `durationMs`, and `tokens`.
 */
export interface ClaudeGoalOutcome {
    status: 'complete' | 'failed';
    objective: string;
    reason?: string;
    durationMs?: number;
    tokens?: number;
}

const finiteNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * The outcome a `goal_status` attachment records, or `undefined` for one that only set the goal or found it unmet.
 */
export function claudeGoalOutcome(
    attachment: Record<string, unknown>,
): ClaudeGoalOutcome | undefined {
    if (attachment.type !== 'goal_status') return undefined;
    const status =
        attachment.met === true ? 'complete' : attachment.failed === true ? 'failed' : undefined;
    if (!status) return undefined;
    const reason = stringField(attachment.reason)?.trim();
    const durationMs = finiteNumber(attachment.durationMs);
    const tokens = finiteNumber(attachment.tokens);
    return {
        status,
        objective: clip(
            stringField(attachment.condition)?.trim() ?? '',
            MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH,
        ),
        ...(reason && { reason: clip(reason, MAX_AGENT_CHAT_GOAL_REASON_LENGTH) }),
        ...(durationMs !== undefined && { durationMs }),
        ...(tokens !== undefined && { tokens: Math.round(tokens) }),
    };
}

/**
 * The outcome of the transcript's latest goal check dated at or after `since`, or `undefined` when that check found the
 * goal unmet or no check is that recent. Reads from the end, since the check that settled a goal is among the turn's
 * last records.
 */
function latestClaudeGoalOutcome(transcript: string, since: number): ClaudeGoalOutcome | undefined {
    const lines = transcript.split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index];
        if (!line.includes('"goal_status"')) continue;
        let record: unknown;
        try {
            record = JSON.parse(line);
        } catch {
            continue;
        }
        if (!isRecord(record) || record.type !== 'attachment' || !isRecord(record.attachment))
            continue;
        if (record.attachment.type !== 'goal_status' || record.isSidechain === true) continue;
        const at = Date.parse(stringField(record.timestamp) ?? '');
        if (!Number.isFinite(at) || at < since) return undefined;
        return claudeGoalOutcome(record.attachment);
    }
    return undefined;
}

/**
 * The goal row after Claude Code settled the goal: it stays with its outcome until the user clears it or sets another,
 * as a Codex goal that completed does, so the row says whether the goal was achieved instead of just disappearing.
 */
export function endedClaudeGoal(
    goal: Pick<AgentChatGoal, 'objective' | 'timeUsedSeconds'>,
    outcome: ClaudeGoalOutcome,
    now: number,
): AgentChatGoal {
    return {
        objective: goal.objective,
        status: outcome.status,
        tokensUsed: outcome.tokens ?? 0,
        timeUsedSeconds:
            outcome.durationMs === undefined
                ? goal.timeUsedSeconds
                : Math.round(outcome.durationMs / 1000),
        updatedAt: now,
        ...(outcome.reason && { reason: outcome.reason }),
        pausable: false,
    };
}

/**
 * Whether a command is `/goal clear` sent while an active goal is set and a turn runs. Claude Code's SDK mode holds a
 * slash command until the running query ends (only its interactive `/goal` runs beside a turn), and the goal's query
 * keeps going until the condition is met, so a clear that waited for the turn would never land.
 */
export function isClaudeGoalClearDuringTurn(
    snapshot: AgentChatSnapshot,
    name: string,
    arguments_: string | undefined,
): boolean {
    return (
        Boolean(snapshot.activeTurnId && snapshot.goal?.status === 'active') &&
        name === AGENT_CHAT_GOAL_COMMAND &&
        parseAgentChatGoalArguments(arguments_)?.action === 'clear'
    );
}

/**
 * A Claude Code session's `/goal`, kept in the snapshot's `goal` so the composer's goal row shows it while Claude works
 * toward it. Claude Code streams no goal state to the SDK (its `active_goal` frames stay internal outside remote
 * sessions), so this reads what it does stream: the `/goal` replies say a goal was set, is active, or was cleared, and
 * the turn ends say when it was met. `/goal <condition>` is one query that keeps going while the Stop hook finds the
 * condition unmet, so a turn that completes with no background work left to wake it passed that check and the goal is
 * gone; an interrupted or failed turn leaves the goal for the next one, as Claude Code does. Whether that check found
 * the goal met or impossible is written only to the transcript, so the ended goal is read back from there.
 */
export class ClaudeGoals {
    /**
     * A turn that only printed the goal (`/goal` with no condition): it never ran the goal's check, so its end says
     * nothing about whether the goal was met.
     */
    private statusTurnId: string | undefined;

    constructor(
        private readonly host: Pick<
            AgentChatSessionHost,
            'apply' | 'lifecycle' | 'read' | 'readTranscript'
        >,
        private readonly retryDelayMs = 250,
    ) {}

    private set(goal: AgentChatGoal | null): void {
        this.host.apply([{ op: 'state', state: { goal } }]);
    }

    /**
     * Reads how `goal` ended from the transcript and shows it in the row, with `worked` carrying the time the ending
     * turn added when Claude Code reports none. Without a readable outcome (an older Claude Code, an unreadable
     * transcript) the goal is cleared as before. Skips the update when the goal changed meanwhile, such as a new
     * `/goal` sent right after the turn.
     */
    private async settle(
        goal: AgentChatGoal,
        worked: AgentChatGoal,
        since: number,
        now: number,
    ): Promise<void> {
        let outcome: ClaudeGoalOutcome | undefined;
        for (let attempt = 0; attempt < OUTCOME_READ_ATTEMPTS; attempt++) {
            // Claude Code appends to the transcript asynchronously, so the settling check can land just after `result`.
            // eslint-disable-next-line no-await-in-loop -- each retry waits for the previous read to miss
            if (attempt > 0) await delay(this.retryDelayMs);
            if (this.host.read().goal !== goal) return;
            try {
                // eslint-disable-next-line no-await-in-loop -- see above
                const transcript = await this.host.readTranscript();
                outcome = transcript && latestClaudeGoalOutcome(transcript.content, since);
            } catch {
                outcome = undefined;
            }
            if (outcome) break;
        }
        if (this.host.read().goal !== goal) return;
        this.set(outcome ? endedClaudeGoal(worked, outcome, now) : null);
    }

    /**
     * Shows a frame's feedback in Chat and reads the goal from it. Returns whether the frame carried any.
     */
    applyFeedback(message: Record<string, unknown>, scope?: 'agent' | 'session'): boolean {
        const notices = applyClaudeFeedback(this.host, message, scope);
        this.onNotices(notices);
        return notices.length > 0;
    }

    /**
     * Notices a frame added: a `/goal` reply, or Claude Code clearing the goal after an error.
     */
    onNotices(notices: readonly Notice[], now = Date.now()): void {
        for (const notice of notices) {
            const reply = claudeGoalNotice(notice);
            if (reply === undefined) continue;
            if (reply === null) {
                this.set(null);
                continue;
            }
            if (reply.action === 'active') this.statusTurnId = this.host.read().activeTurnId;
            const current = this.host.read().goal;
            const objective = clip(reply.objective, MAX_AGENT_CHAT_GOAL_OBJECTIVE_LENGTH);
            // A status check of the same goal keeps the time it has been worked on.
            if (reply.action === 'active' && current?.objective === objective) continue;
            this.set({
                objective,
                status: 'active',
                tokensUsed: 0,
                timeUsedSeconds: 0,
                updatedAt: now,
                pausable: false,
            });
        }
    }

    /**
     * A turn ended. One that completed with nothing left to wake Claude Code settled the goal; any other that worked on
     * the goal keeps it with the turn's time added, so the row's time does not restart from the last report. A goal
     * that already ended is left as it is.
     */
    onTurnEnded(
        turn: { id: string; status: AgentChatTurn['status']; startedAt: number | undefined },
        isWaitingOnBackground: boolean,
        now = Date.now(),
    ): void {
        const isStatusTurn = this.statusTurnId === turn.id;
        this.statusTurnId = undefined;
        const goal = this.host.read().goal;
        // A turn that only printed the goal did not work on it, so its time is not the goal's.
        if (isStatusTurn || goal?.status !== 'active') return;
        if (!isWaitingOnBackground && turn.status === 'completed') {
            const worked = {
                ...goal,
                timeUsedSeconds: agentChatGoalElapsedSeconds(goal, now, turn.startedAt),
            };
            void this.settle(goal, worked, turn.startedAt ?? now, now);
            return;
        }
        this.set({
            ...goal,
            timeUsedSeconds: agentChatGoalElapsedSeconds(goal, now, turn.startedAt),
            updatedAt: now,
        });
    }
}

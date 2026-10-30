import type { AgentChatTurn } from '@caxri/protocol';

import { isRecord } from '../chat-items';
import { isHumanQueuedClaudePrompt } from '../providers/claude/input';

/**
 * Times the turns of a replayed Claude Code transcript from their records' timestamps. Claude Code writes a
 * `turn_duration` record only in its interactive CLI, never for an SDK-driven Chat, so a replayed Chat turn otherwise
 * has no duration and its fold row loses `Worked for` (issue #3132).
 *
 * A turn's work is one or more spans. A wake record opens a new span, so the time an Agent sat idle after its reply,
 * until a background task notification or the next queued prompt woke it, never counts. A wake record that lands
 * mid-turn drops only the short gap since the previous record.
 */
export class ClaudeTurnClock {
    private clock:
        | {
              turn: AgentChatTurn;
              startedAt: number;
              /**
               * The spans before `spanStartedAt`.
               */
              workedMs: number;
              spanStartedAt: number;
              lastAt: number;
          }
        | undefined;

    /**
     * Advances the clock with one main-thread record dated `at`. `openedTurn` is the turn the record opened, if any.
     */
    tick(
        record: Record<string, unknown>,
        at: number | undefined,
        openedTurn?: AgentChatTurn,
    ): void {
        if (at === undefined) return;
        if (openedTurn) {
            this.settle();
            this.clock = {
                turn: openedTurn,
                startedAt: at,
                workedMs: 0,
                spanStartedAt: at,
                lastAt: at,
            };
            return;
        }
        const { clock } = this;
        if (!clock || at < clock.lastAt) return;
        if (isWakeRecord(record)) {
            clock.workedMs += clock.lastAt - clock.spanStartedAt;
            clock.spanStartedAt = at;
        }
        clock.lastAt = at;
    }

    /**
     * Dates the clocked turn and, unless Claude Code wrote its `turn_duration`, gives it the time its spans covered.
     */
    settle(): void {
        const { clock } = this;
        if (!clock) return;
        clock.turn.startedAt = clock.startedAt;
        clock.turn.durationMs ??= clock.workedMs + clock.lastAt - clock.spanStartedAt;
        this.clock = undefined;
    }
}

/**
 * Whether a record queues input that may wake an Agent idle since its reply. Claude Code writes an `enqueue` queue
 * operation before every queued prompt or background task notification, and a `queued_command` attachment for the
 * notification itself (verified with Claude Code 2.1.310).
 */
function isWakeRecord(record: Record<string, unknown>): boolean {
    if (record.type === 'queue-operation') return record.operation === 'enqueue';
    return (
        record.type === 'attachment' &&
        isRecord(record.attachment) &&
        record.attachment.type === 'queued_command' &&
        !isHumanQueuedClaudePrompt(record.attachment)
    );
}

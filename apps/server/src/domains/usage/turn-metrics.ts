import type {
    AgentChatPatchOperation,
    AgentChatSnapshot,
    AgentChatTurn,
    AgentChatTurnMetrics,
    AgentChatTurnUsage,
    AgentThroughput,
    AgentThroughputAggregate,
} from '@caxri/protocol';
import { AGENT_THROUGHPUT_SAMPLE_LIMIT } from '@caxri/protocol';

/**
 * How far past the turn's end a response may complete and still count as the turn's. The transcript stamps a response
 * when its last item is written, which can trail the Chat's own end-of-turn clock by a moment.
 */
const TURN_END_GRACE_MS = 5_000;

/**
 * The finished turn's generation totals from the transcript throughput read at its end. The responses whose completion
 * falls inside the turn's own window are summed, so a queued follow-up that already started the next turn in the
 * transcript cannot leak into this one. When the sample window is full and starts inside the turn, earlier responses
 * were dropped from it, so the scanner's running `turn` total covers the turn instead.
 */
export function chatTurnThroughput(
    throughput: Pick<AgentThroughput, 'samples' | 'turn'> | null | undefined,
    turn: Pick<AgentChatTurn, 'durationMs' | 'startedAt'>,
): Pick<AgentThroughputAggregate, 'durationMs' | 'outputTokens'> | undefined {
    if (!throughput || turn.startedAt === undefined || turn.durationMs === undefined)
        return undefined;
    const startedAt = turn.startedAt;
    const endedAt = startedAt + turn.durationMs + TURN_END_GRACE_MS;
    const oldest = throughput.samples.at(0);
    const isWindowTruncated =
        throughput.samples.length >= AGENT_THROUGHPUT_SAMPLE_LIMIT &&
        oldest !== undefined &&
        oldest.completedAt >= startedAt;
    if (isWindowTruncated) return throughput.turn.outputTokens > 0 ? throughput.turn : undefined;
    let outputTokens = 0;
    let durationMs = 0;
    for (const sample of throughput.samples) {
        if (sample.completedAt < startedAt || sample.completedAt > endedAt) continue;
        outputTokens += sample.outputTokens;
        durationMs += sample.durationMs;
    }
    return outputTokens > 0 ? { outputTokens, durationMs } : undefined;
}

/**
 * The state operation that records a finished turn's metrics on the turn itself, or `undefined` when there is nothing
 * to record. `usage` is the Chat's running `turnUsage`, captured when the turn ended and only used if it is this
 * turn's.
 */
export function chatTurnMetricsOperation(
    snapshot: Pick<AgentChatSnapshot, 'turns'>,
    turnId: string,
    usage: AgentChatTurnUsage | undefined,
    throughput: Pick<AgentThroughput, 'samples' | 'turn'> | null | undefined,
): AgentChatPatchOperation | undefined {
    const turn = snapshot.turns.find((candidate) => candidate.id === turnId);
    if (!turn) return undefined;
    const generated = chatTurnThroughput(throughput, turn);
    const ownUsage = usage?.turnId === turnId ? usage : undefined;
    const costUsd = ownUsage?.costUsd;
    const metrics: AgentChatTurnMetrics = {
        ...(generated && {
            outputTokens: generated.outputTokens,
            generationMs: generated.durationMs,
        }),
        ...(costUsd !== undefined && { costUsd }),
        ...(ownUsage && ownUsage.requests > 0 && { requests: ownUsage.requests }),
        ...(ownUsage && ownUsage.totalTokens > 0 && { totalTokens: ownUsage.totalTokens }),
    };
    if (Object.keys(metrics).length === 0) return undefined;
    return {
        op: 'state',
        state: {
            turns: snapshot.turns.map((candidate) =>
                candidate.id === turnId ? { ...candidate, metrics } : candidate,
            ),
        },
    };
}

/**
 * Records a finished turn's metrics once the transcript has been read. `usage` is captured synchronously at the turn's
 * end, before the read, because the next turn's first response replaces it. A failed read records the cost alone.
 */
export async function recordChatTurnMetrics(
    host: {
        apply: (operations: AgentChatPatchOperation[]) => void;
        isCurrent: () => boolean;
        read: () => Pick<AgentChatSnapshot, 'turnUsage' | 'turns'>;
        readThroughput: () => Promise<AgentThroughput | null>;
    },
    turnId: string,
): Promise<void> {
    const usage = host.read().turnUsage;
    let throughput: AgentThroughput | null = null;
    try {
        throughput = await host.readThroughput();
    } catch {
        // An unreadable transcript still leaves the cost to record.
    }
    if (!host.isCurrent()) return;
    const operation = chatTurnMetricsOperation(host.read(), turnId, usage, throughput);
    if (operation) host.apply([operation]);
}

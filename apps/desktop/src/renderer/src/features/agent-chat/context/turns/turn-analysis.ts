import type { AgentChatContextRequest, AgentChatContextTurn } from '@caxri/protocol';

/**
 * The window after one request, by where its content came from. `base` is what the window already held when the replay
 * (or the latest compaction) began: system prompt, tools, memory, and any earlier history. The other parts accumulate
 * what each later request added.
 */
export interface ContextTurnPoint {
    at: number;
    /**
     * Prompt tokens of the request, i.e. the window as that request saw it.
     */
    prompt: number;
    afterCompaction: boolean;
    base: number;
    user: number;
    modelOutput: number;
    toolResults: number;
    /**
     * What this request added over the previous one. Absent for the oldest request, after a compaction, and when the
     * transcript could not attribute the growth.
     */
    turn?: AgentChatContextTurn;
    /**
     * Total of {@link turn}, or 0 without one.
     */
    growth: number;
}

export interface ContextTurnAnalysis {
    points: ContextTurnPoint[];
    /**
     * Position of the request that added the most, if any request added anything.
     */
    largestGrowthIndex?: number;
}

/**
 * Accumulates the requests' per-turn growth into how the window filled up, restarting at each compaction. The
 * cumulative parts are scaled down when the prompt itself shrank (an edited history), so they never exceed it.
 */
export function analyzeContextTurns(
    requests: readonly AgentChatContextRequest[],
): ContextTurnAnalysis {
    const points: ContextTurnPoint[] = [];
    let largestGrowthIndex: number | undefined;
    let user = 0;
    let modelOutput = 0;
    let toolResults = 0;
    for (const [index, request] of requests.entries()) {
        const prompt = request.input + request.cacheRead + request.cacheWrite;
        const isAfterCompaction = request.afterCompaction === true;
        const { turn } = request;
        if (index === 0 || isAfterCompaction) {
            user = 0;
            modelOutput = 0;
            toolResults = 0;
        } else if (turn) {
            user += turn.user;
            modelOutput += turn.modelOutput;
            toolResults += turn.toolResults;
        }
        const parts = user + modelOutput + toolResults;
        if (parts > prompt) {
            const scale = prompt / parts;
            user *= scale;
            modelOutput *= scale;
            toolResults *= scale;
        }
        const growth = turn ? turn.user + turn.modelOutput + turn.toolResults : 0;
        if (
            growth > 0 &&
            (largestGrowthIndex === undefined || growth > points[largestGrowthIndex].growth)
        )
            largestGrowthIndex = index;
        points.push({
            at: request.at,
            prompt,
            afterCompaction: isAfterCompaction,
            base: Math.max(0, prompt - user - modelOutput - toolResults),
            user,
            modelOutput,
            toolResults,
            ...(turn && !isAfterCompaction && index > 0 && { turn }),
            growth: isAfterCompaction || index === 0 ? 0 : growth,
        });
    }
    return { points, ...(largestGrowthIndex !== undefined && { largestGrowthIndex }) };
}

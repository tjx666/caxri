import type {
    AgentChatItem,
    AgentChatPatchOperation,
    AgentChatSnapshot,
    BenchmarkContextUsage,
} from '@caxri/protocol';

/**
 * Timeline items the model produces. The first one after the prompt marks time to first token; a user message or a
 * Caxri notice does not.
 */
const OUTPUT_ITEM_TYPES = new Set<AgentChatItem['type']>([
    'agentMessage',
    'reasoning',
    'command',
    'fileChange',
    'toolCall',
]);

export interface TurnMetricsResult {
    timeToFirstTokenMs?: number;
    context?: BenchmarkContextUsage;
    compactions?: number;
}

/**
 * Reads time to first token, context usage, and compactions from one headless turn's Chat stream. Every provider driver
 * reports these through the same projection (a `compacted` notice, the snapshot's `usage`), so no provider needs its
 * own reader. Keeps numbers only, never item content.
 */
export class TurnMetrics {
    private startedAt: number | undefined;
    private firstOutputAt: number | undefined;
    private readonly compactions = new Set<string>();
    private context: BenchmarkContextUsage | undefined;

    constructor(private readonly now: () => number = Date.now) {}

    /**
     * Marks the prompt as sent. Output and compactions before this belong to the provider's startup, not the turn.
     */
    start(): void {
        this.startedAt = this.now();
    }

    observe(operations: readonly AgentChatPatchOperation[], snapshot: AgentChatSnapshot): void {
        if (this.startedAt === undefined) return;
        for (const operation of operations) {
            if (operation.op !== 'upsertItem') continue;
            const { item } = operation;
            if (item.type === 'notice' && item.kind === 'compacted') this.compactions.add(item.id);
            if (this.firstOutputAt === undefined && OUTPUT_ITEM_TYPES.has(item.type))
                this.firstOutputAt = this.now();
        }
        const usage = snapshot.usage;
        if (!usage) return;
        this.context = {
            peakTokens: Math.max(this.context?.peakTokens ?? 0, usage.totalTokens),
            finalTokens: usage.totalTokens,
            ...(usage.contextWindow && { window: usage.contextWindow }),
            ...(usage.compactWindow && { compactWindow: usage.compactWindow }),
        };
    }

    result(): TurnMetricsResult {
        if (this.startedAt === undefined) return {};
        return {
            compactions: this.compactions.size,
            ...(this.firstOutputAt !== undefined && {
                timeToFirstTokenMs: this.firstOutputAt - this.startedAt,
            }),
            ...(this.context && { context: this.context }),
        };
    }
}

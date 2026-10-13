import type {
    AgentProvider,
    BenchmarkCostSource,
    BenchmarkGeneration,
    UsageTokenBreakdown,
} from '@caxri/protocol';

import type { AgentEnvironment, AgentTranscriptLocation } from '../agents';
import { agentProviders, scanTranscriptToEnd, ThroughputAccumulator } from '../agents';
import type { UsageScanTarget, UsageTranscriptFiles } from './scanner';
import { IncrementalUsageScan, UsageTranscriptLocator } from './scanner';
import type { ModelPriceLookup } from './summary';
import { addToBreakdown, emptyTokenBreakdown, pricedUsageBuckets } from './summary';

/**
 * What one finished Agent conversation used, read from its transcript the same way the Usage page reads it.
 */
export interface ConversationUsage {
    tokens: UsageTokenBreakdown;
    /**
     * Absent when any model the conversation used has neither a provider-reported cost nor a list price, so a partial
     * sum is never shown as the whole cost.
     */
    costUsd?: number;
    costSource: BenchmarkCostSource;
    models: string[];
    /**
     * Absent when the provider's transcript carries no per-response timing (Grok Build).
     */
    generation?: BenchmarkGeneration;
}

/**
 * Measures one conversation's tokens and cost from its on-disk transcript. `provider` cost wins when the Agent recorded
 * its own (Grok Build); otherwise tokens are priced at the API list price. Resolves `undefined` when the transcript is
 * not found or holds no usage yet.
 */
export async function measureConversationUsage(
    environment: AgentEnvironment,
    priceOf: ModelPriceLookup,
    identity: UsageScanTarget,
): Promise<ConversationUsage | undefined> {
    const files = await new UsageTranscriptLocator(environment).locate(identity);
    if (!files) return undefined;
    const scan = new IncrementalUsageScan(identity.provider);
    await scan.advance(files);
    const record = scan.toRecord();
    if (record.tokens.length === 0) return undefined;
    const generation = await measureGeneration(identity.provider, files);
    const tokens = emptyTokenBreakdown();
    let costUsd = 0;
    let isPriced = true;
    let isNative = true;
    for (const bucket of pricedUsageBuckets(record, priceOf)) {
        addToBreakdown(tokens, bucket.tokens);
        costUsd += bucket.costUsd;
        if (!bucket.isPriced) isPriced = false;
        if (!bucket.isNativeCost) isNative = false;
    }
    if (!isPriced)
        return {
            tokens,
            costSource: 'unknown',
            models: record.models,
            ...(generation && { generation }),
        };
    return {
        tokens,
        ...(generation && { generation }),
        costUsd,
        costSource: isNative ? 'provider' : 'listPrice',
        models: record.models,
    };
}

/**
 * Sums the output tokens and generation time of every measured model response, with the same provider scanners the
 * status bar's throughput uses. Subagent side files are left out: their responses overlap the main turn in time.
 */
async function measureGeneration(
    provider: AgentProvider,
    files: UsageTranscriptFiles,
): Promise<BenchmarkGeneration | undefined> {
    const createScanner = agentProviders[provider].createThroughputScanner;
    if (!createScanner) return undefined;
    const locations: AgentTranscriptLocation[] = [...files.earlier, files.main];
    // Session totals are running sums of independent responses, so each file can be measured on its own and added up.
    const sessions = await Promise.all(
        locations.map(async (location) => {
            const accumulator = new ThroughputAccumulator();
            const scanner = createScanner();
            await scanTranscriptToEnd(location, { offset: 0 }, (line) =>
                scanner.scanLine(line, accumulator),
            );
            return accumulator.snapshot(provider)?.session;
        }),
    );
    const session = sessions.reduce<{
        outputTokens: number;
        durationMs: number;
        responseCount: number;
    }>(
        (sum, next) => ({
            outputTokens: sum.outputTokens + (next?.outputTokens ?? 0),
            durationMs: sum.durationMs + (next?.durationMs ?? 0),
            responseCount: sum.responseCount + (next?.responseCount ?? 0),
        }),
        { outputTokens: 0, durationMs: 0, responseCount: 0 },
    );
    const durationMs = Math.round(session.durationMs);
    if (session.responseCount === 0 || durationMs < 1) return undefined;
    return { outputTokens: session.outputTokens, durationMs, responses: session.responseCount };
}

import type { BenchmarkCostSource, UsageTokenBreakdown } from '@caxri/protocol';

import type { AgentEnvironment } from '../agents';
import type { UsageScanTarget } from './scanner';
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
    if (!isPriced) return { tokens, costSource: 'unknown', models: record.models };
    return {
        tokens,
        costUsd,
        costSource: isNative ? 'provider' : 'listPrice',
        models: record.models,
    };
}

import type { AgentUsageReadout } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

import type { AgentEnvironment, AgentTranscriptIdentity } from '../agents';
import { boundAgentIdentity } from '../agents';
import type { CaxriDatabase } from '../db';
import { SingleFlight } from '../single-flight';
import type { UsageTranscriptFiles } from './scanner';
import { IncrementalUsageScan, UsageTranscriptLocator } from './scanner';
import type { ModelPriceLookup } from './summary';
import { summarizeUsage } from './summary';

const MAX_LIVE_SCANS = 32;
/**
 * Locating a conversation's files lists Claude subagent folders and, for a reverted Codex thread, up to two months of
 * day folders, so a location is reused this long between status-bar polls. A subagent started meanwhile is picked up on
 * the next lookup; appended bytes in files already known are read on every poll.
 */
const LOCATION_REUSE_MS = 15_000;

interface LiveScan {
    agentSessionId: string;
    scan: IncrementalUsageScan;
    files?: UsageTranscriptFiles;
    locatedAt: number;
}

/**
 * Keeps one {@link IncrementalUsageScan} per Agent Terminal so the status bar can poll the bound conversation's running
 * usage: each read parses only records appended since the previous one. A rebind to another conversation starts over.
 * Only token counts, model names, and rate-limit percentages are retained, never transcript content.
 */
export class LiveAgentUsage {
    private readonly scans = new Map<string, LiveScan>();
    private readonly reads = new SingleFlight<string, AgentUsageReadout | null>();
    private readonly locator: UsageTranscriptLocator;

    constructor(
        private readonly database: CaxriDatabase,
        environment: AgentEnvironment,
        private readonly priceOf: ModelPriceLookup,
        private readonly now: () => number = Date.now,
    ) {
        this.locator = new UsageTranscriptLocator(environment, new Map(), now);
    }

    private async advance(
        terminalId: string,
        identity: AgentTranscriptIdentity,
    ): Promise<AgentUsageReadout | null> {
        let state = this.scans.get(terminalId);
        if (state?.agentSessionId !== identity.agentSessionId)
            state = {
                agentSessionId: identity.agentSessionId,
                scan: new IncrementalUsageScan(identity.provider),
                locatedAt: 0,
            };
        // Refreshed on every visit so eviction drops the least recently polled Terminal, never the one in view.
        rememberBounded(this.scans, terminalId, state, MAX_LIVE_SCANS);
        if (!state.files || this.now() - state.locatedAt >= LOCATION_REUSE_MS) {
            state.files = await this.locator.locate(identity);
            state.locatedAt = this.now();
        }
        if (!state.files) return null;
        await state.scan.advance(state.files);
        const record = state.scan.toRecord();
        if (record.tokens.length === 0) return null;
        const summary = summarizeUsage(record, this.priceOf);
        return {
            provider: identity.provider,
            tokens: summary.tokens,
            costUsd: summary.costUsd,
            models: record.models,
            unpricedModels: summary.unpricedModels,
            ...(record.rateLimits && {
                limit: { provider: identity.provider, ...record.rateLimits },
            }),
        };
    }

    async read(terminalId: string): Promise<AgentUsageReadout | null> {
        const identity = boundAgentIdentity(this.database, terminalId);
        if (!identity) {
            this.scans.delete(terminalId);
            return null;
        }
        return this.reads.run(terminalId, () => this.advance(terminalId, identity));
    }
}

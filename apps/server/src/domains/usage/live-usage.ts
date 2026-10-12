import type { AgentProvider, AgentUsageReadout, UsageLimit } from '@caxri/protocol';
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
 * The newer of two rate-limit observations for the same provider, keeping `current` on a tie so a repeated read does
 * not churn the reference.
 */
export function newerUsageLimit(
    current: UsageLimit | undefined,
    candidate: UsageLimit,
): UsageLimit {
    return current && current.observedAt >= candidate.observedAt ? current : candidate;
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
    /**
     * Newest rate-limit observation per provider from any source this process has read: every live conversation and
     * every Usage report. A plan limit is account-wide, so the conversation in the active Terminal is not its owner;
     * without this the status bar kept showing that conversation's last reading after another conversation (or the
     * Usage page, reading every transcript) had already seen a newer one.
     */
    private readonly latestLimits = new Map<AgentProvider, UsageLimit>();

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
        if (record.rateLimits)
            this.observeLimits([{ provider: identity.provider, ...record.rateLimits }]);
        const limit = this.latestLimits.get(identity.provider);
        return {
            provider: identity.provider,
            tokens: summary.tokens,
            costUsd: summary.costUsd,
            models: record.models,
            unpricedModels: summary.unpricedModels,
            ...(limit && { limit }),
        };
    }

    /**
     * Records rate-limit observations read elsewhere (a Usage report over every transcript) so the next live read
     * reports the newest one for its provider instead of its own conversation's older reading.
     */
    observeLimits(limits: readonly UsageLimit[]): void {
        for (const limit of limits)
            this.latestLimits.set(
                limit.provider,
                newerUsageLimit(this.latestLimits.get(limit.provider), limit),
            );
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

import { readFile } from 'node:fs/promises';

import type { AgentProvider, AgentUsageReadout, UsageLimit } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';

import type { AgentEnvironment, AgentTranscriptIdentity } from '../agents';
import { boundAgentIdentity } from '../agents';
import type { CaxriDatabase } from '../db';
import type { UsageRecord } from './record';
import type { UsageTranscriptFiles } from './scanner';
import { IncrementalUsageScan, UsageTranscriptLocator } from './scanner';
import type { ModelPriceLookup } from './summary';
import { summarizeUsage } from './summary';

const MAX_LIVE_SCANS = 32;
/**
 * Subagent side files whose spawning tool call is remembered; well above the side files of the conversations in view.
 */
const MAX_SIDE_FILE_OWNERS = 1_024;
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
    private readonly reads = new SingleFlight<string, LiveScan | undefined>();
    /**
     * Claude subagent side file path to the tool call that spawned it, read once from the file's `.meta.json` sibling.
     */
    private readonly sideFileOwners = new Map<string, string>();
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
        /**
         * Receives each provider's newest reading after every observation; the weekly usage guard arms on it.
         */
        private readonly onLimit?: (limit: UsageLimit) => void,
    ) {
        this.locator = new UsageTranscriptLocator(environment, new Map(), now);
    }

    private async advance(
        terminalId: string,
        identity: AgentTranscriptIdentity,
    ): Promise<LiveScan | undefined> {
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
        if (!state.files) return undefined;
        await state.scan.advance(state.files);
        return state;
    }

    private readout(provider: AgentProvider, record: UsageRecord): AgentUsageReadout | null {
        if (record.tokens.length === 0) return null;
        const summary = summarizeUsage(record, this.priceOf);
        return {
            provider,
            tokens: summary.tokens,
            costUsd: summary.costUsd,
            models: record.models,
            unpricedModels: summary.unpricedModels,
        };
    }

    /**
     * The tool call that spawned the subagent writing this side file. Claude Code records it as `toolUseId` in
     * `subagents/agent-<id>.meta.json`; a file without readable metadata is asked again on the next read.
     */
    private async sideFileOwner(path: string): Promise<string | undefined> {
        const known = this.sideFileOwners.get(path);
        if (known) return known;
        try {
            const meta = JSON.parse(
                await readFile(path.replace(/\.jsonl$/, '.meta.json'), 'utf8'),
            ) as { toolUseId?: unknown } | null;
            const owner = typeof meta?.toolUseId === 'string' ? meta.toolUseId : undefined;
            if (owner) rememberBounded(this.sideFileOwners, path, owner, MAX_SIDE_FILE_OWNERS);
            return owner;
        } catch {
            return undefined;
        }
    }

    private async refresh(terminalId: string): Promise<LiveScan | undefined> {
        const identity = boundAgentIdentity(this.database, terminalId);
        if (!identity) {
            this.scans.delete(terminalId);
            return undefined;
        }
        return this.reads.run(terminalId, () => this.advance(terminalId, identity));
    }

    /**
     * Records rate-limit observations read elsewhere (a Usage report over every transcript) so the next live read
     * reports the newest one for its provider instead of its own conversation's older reading.
     */
    observeLimits(limits: readonly UsageLimit[]): void {
        for (const limit of limits) {
            const latest = newerUsageLimit(this.latestLimits.get(limit.provider), limit);
            this.latestLimits.set(limit.provider, latest);
            this.onLimit?.(latest);
        }
    }

    async read(terminalId: string): Promise<AgentUsageReadout | null> {
        const state = await this.refresh(terminalId);
        if (!state) return null;
        const { provider } = state.scan;
        const record = state.scan.toRecord();
        const readout = this.readout(provider, record);
        if (!readout) return null;
        if (record.rateLimits) this.observeLimits([{ provider, ...record.rateLimits }]);
        const limit = this.latestLimits.get(provider);
        return { ...readout, ...(limit && { limit }) };
    }

    /**
     * What one subagent of the bound conversation billed, keyed by the tool call that spawned it (the Chat's task id),
     * and priced like {@link read}. Units it repeats from its parent stay with the parent, so the subagents' shares
     * never add up to more than the conversation. Claude only: Codex and Grok Build keep no per-subagent transcript.
     */
    async readTask(terminalId: string, taskId: string): Promise<AgentUsageReadout | null> {
        const state = await this.refresh(terminalId);
        if (state?.scan.provider !== 'claude' || !state.files) return null;
        for (const location of state.files.side) {
            // eslint-disable-next-line no-await-in-loop -- stops at the subagent's file; owners are cached after the first read
            if ((await this.sideFileOwner(location.path)) !== taskId) continue;
            const record = state.scan.sideRecord(location.path);
            return record ? this.readout('claude', record) : null;
        }
        return null;
    }
}

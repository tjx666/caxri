import type { AgentProvider, AgentThroughput } from '@caxri/protocol';
import { SingleFlight } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';

import type { CaxriDatabase } from '../db';
import type { AgentEnvironment } from './contract';
import { defaultAgentEnvironment } from './contract';
import { agentProviders } from './providers';
import type { ThroughputLineScanner } from './throughput';
import { ThroughputAccumulator } from './throughput';
import { locateAgentTranscript } from './transcript';
import { scanTranscriptToEnd } from './transcript-scan';
import type { AgentTranscriptLocation } from './transcript-security';

const MAX_THROUGHPUT_SCANS = 32;
/**
 * Codex rollouts cannot be derived purely (`locateCodexTranscript` lists day folders and reads Codex's state database
 * to follow a reverted thread), so a location is reused for this long instead of being looked up on every status-bar
 * poll. A rebind to another Agent session invalidates it immediately.
 */
const LOCATION_REUSE_MS = 15_000;

interface ThroughputScan {
    accumulator: ThroughputAccumulator;
    cursor: { offset: number; skippingOversizedLine?: boolean };
    scanner: ThroughputLineScanner;
}

interface CachedLocation {
    agentSessionId: string;
    location: AgentTranscriptLocation;
    locatedAt: number;
}

/**
 * Measures the output throughput of an Agent Terminal's bound conversation for the status bar. One incremental cursor
 * per transcript file reads only bytes appended since the previous poll; concurrent polls join the same read. Only
 * running token and duration totals are retained, never transcript content.
 */
export class AgentThroughputService {
    private readonly locations = new Map<string, CachedLocation>();
    private readonly reads = new SingleFlight<string, AgentThroughput | null>();
    private readonly scans = new Map<string, ThroughputScan>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly environment: AgentEnvironment = defaultAgentEnvironment(),
        private readonly now: () => number = Date.now,
    ) {}

    private async locationFor(
        terminalId: string,
        agentSessionId: string,
    ): Promise<AgentTranscriptLocation | undefined> {
        const cached = this.locations.get(terminalId);
        if (
            cached?.agentSessionId === agentSessionId &&
            this.now() - cached.locatedAt < LOCATION_REUSE_MS
        )
            return cached.location;
        const location = await locateAgentTranscript(this.database, terminalId, this.environment);
        if (location)
            rememberBounded(
                this.locations,
                terminalId,
                { agentSessionId, location, locatedAt: this.now() },
                MAX_THROUGHPUT_SCANS,
            );
        else this.locations.delete(terminalId);
        return location;
    }

    private async scan(
        location: AgentTranscriptLocation,
        provider: AgentProvider,
        createScanner: () => ThroughputLineScanner,
    ): Promise<AgentThroughput | null> {
        const create = (): ThroughputScan => ({
            accumulator: new ThroughputAccumulator(),
            cursor: { offset: 0 },
            scanner: createScanner(),
        });
        let state = this.scans.get(location.path) ?? create();
        // Refreshed on every visit so eviction drops the least recently polled transcript, never the one in view.
        rememberBounded(this.scans, location.path, state, MAX_THROUGHPUT_SCANS);
        await scanTranscriptToEnd(
            location,
            state.cursor,
            (line) => state.scanner.scanLine(line, state.accumulator),
            {
                onReset: () => {
                    // The provider rewrote the file; totals derived from bytes that no longer exist are dropped.
                    const cursor = state.cursor;
                    state = { ...create(), cursor };
                    this.scans.set(location.path, state);
                },
            },
        );
        return state.accumulator.snapshot(provider);
    }

    async read(terminalId: string): Promise<AgentThroughput | null> {
        const terminal = this.database.getTerminal(terminalId);
        const provider = terminal?.provider;
        const agentSessionId = terminal?.agentSessionId;
        if (!provider || !agentSessionId) return null;
        const createScanner = agentProviders[provider].createThroughputScanner;
        if (!createScanner) return null;
        const location = await this.locationFor(terminalId, agentSessionId);
        if (!location) return null;
        return this.reads.run(location.path, () => this.scan(location, provider, createScanner));
    }
}

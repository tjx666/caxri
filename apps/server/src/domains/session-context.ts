import type { SessionRecord } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';

import type {
    AgentEnvironment,
    TranscriptLinearReference,
    TranscriptSessionContextScan,
} from './agents';
import {
    createTranscriptSessionContextScan,
    defaultAgentEnvironment,
    locateAgentTranscript,
    resetTranscriptSessionContextScan,
    scanTranscriptLines,
    scanTranscriptSessionContextLine,
} from './agents';
import type { CaxriDatabase } from './db';
import { SingleFlight } from './single-flight';

const MAX_TRANSCRIPT_SCANS = 128;

/**
 * What this Session's own conversation has named, most recent first. Every list is a candidate list: the caller is
 * responsible for proving a directory or branch against live Git topology, and an identifier against a resolved Linear
 * team-key allow-list, before any of it reaches the user.
 */
export interface SessionTranscriptContext {
    branches: readonly string[];
    directories: readonly string[];
    linearReferences: readonly TranscriptLinearReference[];
}

const EMPTY_CONTEXT: SessionTranscriptContext = {
    branches: [],
    directories: [],
    linearReferences: [],
};

/**
 * Reads the working directories, branches, and Linear markers a Session's Agent conversation produced, so the Workbench
 * Root picker and the status bar can lead with what this Session is actually about instead of with repository-wide
 * defaults.
 *
 * Scanning is incremental and shared: one cursor per transcript file reads only the bytes appended since the previous
 * visit, and both consumers join the same in-flight read. A first visit to a long transcript therefore pays once, and
 * the status bar's minute poll costs a `stat` plus whatever the Agent wrote in the last minute.
 *
 * Nothing from the transcript is retained beyond the bounded clue lists — no prompts, no Agent output, no command
 * results — so diagnostics and crash dumps cannot leak conversation content through this service.
 */
export class SessionContextService {
    private readonly environment: AgentEnvironment;
    private readonly reads = new SingleFlight<string, SessionTranscriptContext>();
    private readonly scans = new Map<string, TranscriptSessionContextScan>();

    constructor(
        private readonly database: CaxriDatabase,
        environment: AgentEnvironment = defaultAgentEnvironment(),
    ) {
        this.environment = environment;
    }

    /**
     * Same as {@link read}, for a caller that holds only the Session id. A Session that no longer exists reads as an
     * empty context rather than an error: every consumer degrades to "no extra context" anyway.
     */
    async readSession(sessionId: string): Promise<SessionTranscriptContext> {
        const session = this.database.getSession(sessionId);
        return session ? this.read(session) : EMPTY_CONTEXT;
    }

    async read(session: SessionRecord): Promise<SessionTranscriptContext> {
        if (!session.primaryAgentTerminalId) return EMPTY_CONTEXT;
        const location = await locateAgentTranscript(
            this.database,
            session.primaryAgentTerminalId,
            this.environment,
        );
        if (!location) return EMPTY_CONTEXT;
        return this.reads.run(location.path, async () => {
            // Refreshed on every visit, not only on insert: eviction by creation order would drop the transcript being
            // polled right now, resetting its cursor and re-reading the whole file on the next poll.
            const current = this.scans.get(location.path) ?? createTranscriptSessionContextScan();
            rememberBounded(this.scans, location.path, current, MAX_TRANSCRIPT_SCANS);
            await scanTranscriptLines(
                location,
                current,
                (line) => scanTranscriptSessionContextLine(line, current),
                { onReset: () => resetTranscriptSessionContextScan(current) },
            );
            return {
                branches: current.branches.toReversed(),
                directories: current.directories.toReversed(),
                linearReferences: current.linearReferences.toReversed(),
            };
        });
    }

    clear(): void {
        this.scans.clear();
    }
}

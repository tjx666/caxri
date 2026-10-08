import type { SessionRecord } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';

import type { AcceptanceReference } from './acceptance-link';
import type {
    AgentEnvironment,
    TranscriptLinearReference,
    TranscriptPullRequestReference,
    TranscriptPullRequestScan,
    TranscriptSessionContextScan,
} from './agents';
import {
    createTranscriptPullRequestScan,
    createTranscriptSessionContextScan,
    defaultAgentEnvironment,
    locateAgentTranscript,
    resetTranscriptPullRequestScan,
    resetTranscriptSessionContextScan,
    scanTranscriptPullRequestLine,
    scanTranscriptSessionContextLine,
    scanTranscriptToEnd,
} from './agents';
import type { CaxriDatabase } from './db';
import { SessionContextTelemetry } from './session-context-telemetry';
import { SingleFlight } from './single-flight';

const MAX_TRANSCRIPT_SCANS = 128;

/**
 * What this Session's own conversation has named, most recent first. Every list is a candidate list: the caller is
 * responsible for proving a directory or branch against live Git topology, and an identifier against a resolved Linear
 * team-key allow-list, before any of it reaches the user.
 */
export interface SessionTranscriptContext {
    acceptanceReferences: readonly AcceptanceReference[];
    branches: readonly string[];
    directories: readonly string[];
    linearReferences: readonly TranscriptLinearReference[];
    /**
     * The pull request this conversation delivered (`created`, from a `gh pr create` result) and the one the Agent last
     * named in its own prose (`mentioned`). Unlike the lists above these are not re-ranked here: which one wins, and
     * whether a mention counts at all, is `SessionPullRequestService`'s rule.
     */
    pullRequests: {
        created?: TranscriptPullRequestReference;
        mentioned?: TranscriptPullRequestReference;
    };
}

const EMPTY_CONTEXT: SessionTranscriptContext = {
    acceptanceReferences: [],
    branches: [],
    directories: [],
    linearReferences: [],
    pullRequests: {},
};

/**
 * Both clue scanners behind one cursor, so adding a clue kind never adds another read of the transcript.
 */
interface SessionTranscriptScan {
    context: TranscriptSessionContextScan;
    pullRequests: TranscriptPullRequestScan;
}

/**
 * Reads the working directories, branches, Linear markers, and pull request links a Session's Agent conversation
 * produced, so the Workbench Root picker, the status bar, and the sidebar's pull request badge can lead with what this
 * Session is actually about instead of with repository-wide defaults.
 *
 * Scanning is incremental and shared: one cursor per transcript file reads only the bytes appended since the previous
 * visit, and both consumers join the same in-flight read. The first visit catches up in bounded, yielding passes rather
 * than making each pass wait for another status-bar poll.
 *
 * Nothing from the transcript is retained beyond the bounded clue lists: no prompts, no Agent output, no command
 * results, so diagnostics and crash dumps cannot leak conversation content through this service.
 */
export class SessionContextService {
    private readonly environment: AgentEnvironment;
    private readonly reads = new SingleFlight<string, SessionTranscriptContext>();
    private readonly scans = new Map<string, SessionTranscriptScan>();
    private readonly telemetry: SessionContextTelemetry;

    constructor(
        private readonly database: CaxriDatabase,
        logger: StructuredLogger,
        environment: AgentEnvironment = defaultAgentEnvironment(),
    ) {
        this.environment = environment;
        this.telemetry = new SessionContextTelemetry(logger);
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
            const current = this.scans.get(location.path) ?? {
                context: createTranscriptSessionContextScan(),
                pullRequests: createTranscriptPullRequestScan(),
            };
            rememberBounded(this.scans, location.path, current, MAX_TRANSCRIPT_SCANS);
            const { context, pullRequests } = current;
            const startedAt = performance.now();
            const offsetBefore = context.offset;
            // A plain property (not a bare `let`) so the reset flag set from inside the nested `onReset` callback is
            // unambiguous to read back below, including for type-aware lint's flow analysis across the closure.
            const pass = { didReset: false };
            await scanTranscriptToEnd(
                location,
                context,
                (line) => {
                    scanTranscriptSessionContextLine(line, context);
                    scanTranscriptPullRequestLine(line, pullRequests);
                },
                {
                    onFailure: (reason) => this.telemetry.recordFailure(session.id, reason),
                    onReset: () => {
                        resetTranscriptSessionContextScan(context);
                        resetTranscriptPullRequestScan(pullRequests);
                        pass.didReset = true;
                        this.telemetry.recordReset(session.id);
                    },
                },
            );
            // `context.offset` is the shared cursor scanTranscriptToEnd advanced; its net movement approximates bytes
            // scanned this pass (an undercount only when a per-record-oversized skip or the 4 MiB per-poll ceiling
            // also applied, both already bounded). A pass that reset restarted the cursor at byte zero, so its whole
            // post-reset offset (not the delta against the pre-reset value) is what this pass actually read.
            const bytesScanned = pass.didReset
                ? context.offset
                : Math.max(0, context.offset - offsetBefore);
            this.telemetry.recordScan(session.id, performance.now() - startedAt, bytesScanned);
            return {
                acceptanceReferences: context.acceptanceReferences.toReversed(),
                branches: context.branches.toReversed(),
                directories: context.directories.toReversed(),
                linearReferences: context.linearReferences.toReversed(),
                pullRequests: { created: pullRequests.created, mentioned: pullRequests.mentioned },
            };
        });
    }
}

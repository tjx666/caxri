import type { AgentActivityState } from '@caxri/protocol';
import { mapWithConcurrency } from '@caxri/system';

import type { AgentSnapshotContext, LocalAgentState } from '../../contract';
import { canonicalPath } from '../../contract';
import type { ClaudeSessionMetadata } from './metadata-cache';
import { readClaudeSessionMetadata } from './metadata-cache';
import { resolveClaudeTitle } from './title';

function timestamp(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value) || 0;
    return 0;
}

/**
 * Ceiling on concurrent `realpath` calls while matching Claude's recorded working directories. Before this the fan-out
 * was an unbounded `Promise.all` over every recorded directory, which puts one libuv threadpool thread per entry behind
 * a probe that fires after every burst of PTY activity. Matches the read concurrency the metadata cache already uses.
 */
const MAX_CONCURRENT_CLAUDE_CWD_READS = 8;

function sessionStartedAt(metadata: ClaudeSessionMetadata): number {
    return timestamp(metadata.startedAt) || timestamp(metadata.updatedAt);
}

/**
 * Claude Code's `idle` means only "no turn is running right now": it is written at launch before any turn, after a turn
 * ends, and while the prompt sits empty. It is not evidence that the Agent is blocked on the user, so it must not map
 * to `waiting`: the PrimarySidebar renders a durable amber "needs attention" cue for a waiting Session that never
 * consults read state, which left every finished Session permanently marked. A genuinely blocked Agent reports itself
 * through the explicit `PermissionRequest` hook (`attentionRequested`), so nothing is lost by reading `idle` as the end
 * of a turn instead.
 */
function claudeStatus(value: unknown): AgentActivityState | undefined {
    if (value === 'busy') return 'running';
    if (value === 'idle') return 'completed';
    if (value === 'completed' || value === 'failed') return value;
    return undefined;
}
/**
 * Reads Claude Code's compact live-session metadata, plus a bounded incremental scan of the matched session's own
 * transcript for its AI-generated title (the live metadata `name` is only derived from the working directory).
 */
export async function readClaudeState(
    context: AgentSnapshotContext,
    configDirectory: string,
): Promise<LocalAgentState | undefined> {
    const entries = await readClaudeSessionMetadata(configDirectory);
    if (!entries) return undefined;
    const requestedRoot = await canonicalPath(context.rootPath);
    const excludedSessionIds = new Set(context.excludedAgentSessionIds);
    /**
     * `realpath` is memoized per probe rather than per cached file so a re-pointed symlink or renamed root is seen on
     * the next probe; distinct working directories are few even when the session directory holds hundreds of files.
     */
    // Retained for the whole probe (never evicted on settle), so a plain memo rather than a `SingleFlight`.
    const canonicalCwds = new Map<string, Promise<string>>();
    const canonicalCwd = (cwd: string): Promise<string> => {
        let pending = canonicalCwds.get(cwd);
        if (!pending) {
            pending = canonicalPath(cwd);
            canonicalCwds.set(cwd, pending);
        }
        return pending;
    };
    /**
     * The three in-memory predicates run before any `realpath`, because they are the ones that can reject most of the
     * directory for free. A probe naming its own `agentSessionId` keeps exactly one candidate, so it resolves one path
     * instead of every distinct working directory Claude has ever recorded.
     */
    const candidates = entries.filter(
        (metadata): metadata is ClaudeSessionMetadata & { cwd: string } => {
            if (typeof metadata.cwd !== 'string') return false;
            if (context.agentSessionId) return metadata.sessionId === context.agentSessionId;
            if (
                typeof metadata.sessionId === 'string' &&
                excludedSessionIds.has(metadata.sessionId)
            )
                return false;
            return !(context.startedAt && sessionStartedAt(metadata) < context.startedAt);
        },
    );
    const resolved = await mapWithConcurrency(
        candidates,
        MAX_CONCURRENT_CLAUDE_CWD_READS,
        async (metadata) =>
            (await canonicalCwd(metadata.cwd)) === requestedRoot ? metadata : undefined,
    );
    const matches = resolved.filter((metadata) => metadata !== undefined);
    let latest: ClaudeSessionMetadata | undefined;
    for (const metadata of matches) {
        const isPreferred =
            !context.agentSessionId && context.startedAt
                ? sessionStartedAt(metadata) < sessionStartedAt(latest ?? {})
                : timestamp(metadata.updatedAt) > timestamp(latest?.updatedAt);
        if (!latest || isPreferred) latest = metadata;
    }
    if (!latest) return undefined;
    /**
     * A resumed process can briefly expose the previous turn's terminal status. Keep its identity and title, but do not
     * publish attention until Claude updates metadata in this generation.
     */
    const isStatusIsCurrentGeneration =
        !context.startedAt || timestamp(latest.updatedAt) >= context.startedAt;
    return {
        sessionId: typeof latest.sessionId === 'string' ? latest.sessionId : undefined,
        status: isStatusIsCurrentGeneration ? claudeStatus(latest.status) : undefined,
        ...(await resolveClaudeTitle(latest, configDirectory)),
    };
}

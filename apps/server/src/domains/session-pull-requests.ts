import type {
    AppSettings,
    GitSummary,
    ProjectStatusState,
    ServerEvent,
    SessionPullRequest,
    SessionPullRequests,
    SessionRecord,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency } from '@caxri/system';
import { parseGitHubRemote, rememberBounded } from '@caxri/utils';
import { z } from 'zod';

import type {
    AgentEnvironment,
    AgentTranscriptLocation,
    TranscriptPullRequestScan,
} from './agents';
import {
    createTranscriptPullRequestScan,
    defaultAgentEnvironment,
    locateAgentTranscript,
    resetTranscriptPullRequestScan,
    scanTranscriptLines,
    scanTranscriptPullRequestLine,
} from './agents';
import type { CaxriDatabase } from './db';
import type { ExternalStatusRunner } from './external-status';
import {
    ExternalStatusCliError,
    externalStatusCommandOperation,
    GitHubPullRequestStore,
    isNoPullRequest,
    runExternalStatusCommand,
} from './external-status';
import type { GitService } from './git';
import { parseGitHubPullRequest } from './project-status-parse';

/**
 * Merge state moves on human timescales, so an open PR refreshes once a minute while a merged or closed one only
 * re-confirms every fifteen minutes. A branch with no PR is re-queried every five minutes: the Agent usually opens the
 * PR from inside its own transcript, which the cheap local scan catches on the next sweep without any `gh` call.
 */
const OPEN_TTL_MS = 60_000;
const SETTLED_TTL_MS = 15 * 60_000;
const MISSING_TTL_MS = 5 * 60_000;
/**
 * A failed lookup must not retry sooner than a successful one would refresh. Two minutes was already longer than the
 * open-PR TTL, but a rate-limited `gh` needs the source-level circuit breaker, not a per-Session timer, to recover.
 */
const FAILURE_TTL_MS = 5 * 60_000;
const MAX_CONCURRENT_LOOKUPS = 4;
const MAX_TRANSCRIPT_SCANS = 128;
const MAX_PULL_REQUEST_ENTRIES = 256;
/**
 * Integration branches never carry the Session's own delivery, and querying them would cost a `gh` call per sweep.
 */
const INTEGRATION_BRANCHES = new Set(['main', 'master', 'develop', 'dev', 'trunk', 'HEAD']);
/**
 * Branch discovery only has to answer "which pull request is this branch's?", so it asks for identity and nothing else.
 * `statusCheckRollup` here used to multiply the query's GraphQL cost by every candidate returned; the selected pull
 * request's checks now come from the shared record, which the Status panel and status bar read too.
 */
const BRANCH_DISCOVERY_JSON_FIELDS = 'number,state,isDraft';
/**
 * Enough candidates to rank an open pull request above a merged and a closed one for the same branch, without paying
 * for a page of history nobody renders.
 */
const MAX_BRANCH_CANDIDATES = '5';

const githubPullRequestStateSchema = z.object({
    isDraft: z.boolean().optional(),
    state: z.string().optional(),
});

interface GitHubRemote {
    branch: string;
    owner: string;
    repo: string;
    rootPath: string;
}

interface PullRequestReference {
    number: number;
    owner: string;
    repo: string;
}

interface PullRequestEntry {
    expiresAt: number;
    value?: SessionPullRequest;
}

interface BranchLookupEntry {
    expiresAt: number;
    value?: SessionPullRequest;
}

interface SessionEntry {
    expiresAt: number;
    /**
     * Identity of the PR last resolved for the Session, so a transcript that switches PRs invalidates immediately.
     */
    key?: string;
    value?: SessionPullRequest;
}

export interface SessionPullRequestServiceOptions {
    agentEnvironment?: AgentEnvironment;
    emit?: (event: ServerEvent) => void;
    /**
     * Reads `projectStatus.ignoredChecks` so the sidebar's CI badge aggregates exactly the checks the Status panel
     * shows. Without it the two surfaces would disagree the moment a user ignores a permanently failing job.
     */
    settings?: () => AppSettings;
    /**
     * Server-wide pull-request projection shared with the Status panel, the status bar, and Source Control.
     */
    github?: GitHubPullRequestStore;
    now?: () => number;
    openTtlMs?: number;
    settledTtlMs?: number;
    missingTtlMs?: number;
}

type SessionPullRequestDatabase = Pick<CaxriDatabase, 'getTerminal' | 'listSessions'>;

function pullRequestKey(reference: PullRequestReference): string {
    return `${reference.owner}/${reference.repo}#${reference.number}`;
}

/**
 * Maps the GitHub `state`/`isDraft` pair onto the Session projection. GitHub reports `OPEN`, `MERGED`, or `CLOSED`.
 */
function sessionPullRequestState(
    state: string | undefined,
    isDraft: boolean | undefined,
): SessionPullRequest['state'] | undefined {
    switch ((state ?? '').toUpperCase()) {
        case 'MERGED':
            return 'merged';
        case 'CLOSED':
            return 'closed';
        case 'OPEN':
            return isDraft ? 'draft' : 'open';
        default:
            return undefined;
    }
}

function isSettled(value: SessionPullRequest | undefined): boolean {
    return value?.state === 'merged' || value?.state === 'closed';
}

function projectedChecks(
    checks: ReadonlyArray<{ state: ProjectStatusState }> | undefined,
    aggregate: ProjectStatusState | undefined,
): ProjectStatusState | undefined {
    return checks && checks.length > 0 ? aggregate : undefined;
}

function parseSessionPullRequest(
    output: string,
    source: SessionPullRequest['source'],
    ignoredChecks: readonly string[],
): SessionPullRequest | undefined {
    const parsed = parseGitHubPullRequest(output, ignoredChecks).pullRequest;
    if (!parsed) return undefined;
    const raw = githubPullRequestStateSchema.safeParse(JSON.parse(output));
    const state = raw.success
        ? sessionPullRequestState(raw.data.state, raw.data.isDraft)
        : undefined;
    if (!state) return undefined;
    return {
        number: parsed.number,
        title: parsed.title,
        url: parsed.url,
        state,
        checks: projectedChecks(parsed.checks, parsed.state),
        source,
    };
}

/**
 * Picks the PR that best represents a branch when several exist: a live open PR outranks the merged one that already
 * landed, which outranks an abandoned closed one.
 */
export function selectBranchPullRequest<T extends { state: string; isDraft?: boolean }>(
    candidates: readonly T[],
): T | undefined {
    const rank = (candidate: T): number => {
        switch (candidate.state.toUpperCase()) {
            case 'OPEN':
                return 0;
            case 'MERGED':
                return 1;
            default:
                return 2;
        }
    };
    let best: T | undefined;
    for (const candidate of candidates) if (!best || rank(candidate) < rank(best)) best = candidate;
    return best;
}

/**
 * Discovers and tracks the pull request each active Session is delivering. Discovery prefers the Session's own Agent
 * transcript (the Agent may have opened the PR from a throwaway worktree that the Workbench root never checked out),
 * then falls back to the Workbench root's checked-out branch. State comes from the `gh` CLI with fixed argv, so no
 * token handling or network client lives in Caxri. One background sweep serves every sidebar row; the Renderer never
 * issues per-Session delivery queries.
 */
export class SessionPullRequestService {
    private readonly branchLookups = new Map<string, BranchLookupEntry>();
    private readonly environment: AgentEnvironment;
    private readonly now: () => number;
    private readonly pullRequests = new Map<string, PullRequestEntry>();
    private refreshedAt = 0;
    private readonly sessions = new Map<string, SessionEntry>();
    private sweep?: Promise<void>;
    private readonly transcriptScans = new Map<string, TranscriptPullRequestScan>();
    private readonly github: GitHubPullRequestStore;
    /**
     * Undefined until the first snapshot. Reading settings from the constructor would make merely assembling the Server
     * depend on configuration being loaded, which it is not obliged to be at that point.
     */
    private ignoredChecksSignature?: string;

    constructor(
        private readonly database: SessionPullRequestDatabase,
        private readonly git: Pick<GitService, 'summary'>,
        private readonly logger: StructuredLogger,
        private readonly runner: ExternalStatusRunner = runExternalStatusCommand,
        private readonly options: SessionPullRequestServiceOptions = {},
    ) {
        this.environment = options.agentEnvironment ?? defaultAgentEnvironment();
        this.now = options.now ?? Date.now;
        this.github =
            options.github ?? new GitHubPullRequestStore(this.runner, { now: () => this.now() });
    }

    private ignoredChecks(): readonly string[] {
        return this.options.settings?.()['projectStatus.ignoredChecks'] ?? [];
    }

    /**
     * Expires every projection computed under superseded `projectStatus.ignoredChecks` rules. The badge aggregates the
     * checks that survive the filter, and a merged or closed pull request is otherwise only re-confirmed every fifteen
     * minutes, so without this a newly ignored job would keep a Session row red for a quarter of an hour. Only a real
     * rule change pays for it: the re-sweep spends one cheap branch-discovery query per Session, while the expensive
     * check rollup comes back from the shared pull-request record.
     */
    private expireOnIgnoredChecksChange(): void {
        const signature = JSON.stringify(this.ignoredChecks());
        const previous = this.ignoredChecksSignature;
        this.ignoredChecksSignature = signature;
        if (previous === undefined || previous === signature) return;
        for (const entry of this.sessions.values()) entry.expiresAt = 0;
        for (const entry of this.pullRequests.values()) entry.expiresAt = 0;
        for (const entry of this.branchLookups.values()) entry.expiresAt = 0;
    }

    /**
     * Deleted Sessions vanish from `listSessions()`, so every sweep prunes them; a snapshot never reports a Session
     * that is not currently active.
     */
    private activeSessions(): SessionRecord[] {
        return this.database.listSessions().filter((session) => session.archivedAt === undefined);
    }

    private async runSweep(): Promise<void> {
        const startedAt = performance.now();
        const changed: string[] = [];
        let lookups = 0;
        try {
            const sessions = this.activeSessions();
            const liveIds = new Set(sessions.map((session) => session.id));
            for (const sessionId of this.sessions.keys())
                if (!liveIds.has(sessionId)) this.sessions.delete(sessionId);
            await mapWithConcurrency(sessions, MAX_CONCURRENT_LOOKUPS, async (session) => {
                const previous = this.sessions.get(session.id);
                const result = await this.resolveSessionSafely(session, previous);
                if (result.lookedUp) lookups += 1;
                if (previous && !this.sessions.has(session.id)) return;
                this.sessions.set(session.id, result.entry);
                if (
                    result.entry.value?.state !== previous?.value?.state ||
                    result.entry.value?.checks !== previous?.value?.checks ||
                    result.entry.value?.url !== previous?.value?.url
                )
                    changed.push(session.id);
            });
            this.refreshedAt = this.now();
            this.logger.write('debug', logEventCatalog.sessionPullRequests.refresh, {
                durationMs: performance.now() - startedAt,
                fields: { changed: changed.length, lookups, sessions: sessions.length },
            });
        } catch (error) {
            this.logger.write('warn', logEventCatalog.sessionPullRequests.refreshFailed, {
                durationMs: performance.now() - startedAt,
                fields: { message: error instanceof Error ? error.message : String(error) },
            });
        }
        if (changed.length > 0)
            this.options.emit?.({
                event: 'sessionPullRequests.changed',
                payload: { sessionIds: changed },
            });
    }

    /**
     * `mapWithConcurrency` fails fast, so one Session with a broken checkout (deleted root, unreadable `.git`) would
     * otherwise starve every Session queued behind it on every sweep. Keep that Session's last projection, retry it
     * after the failure back-off, and let the rest of the sweep continue.
     */
    private async resolveSessionSafely(
        session: SessionRecord,
        previous: SessionEntry | undefined,
    ): Promise<{ entry: SessionEntry; lookedUp: boolean }> {
        try {
            return await this.resolveSession(session, previous);
        } catch (error) {
            this.logger.write('debug', logEventCatalog.sessionPullRequests.refreshFailed, {
                fields: {
                    message: error instanceof Error ? error.message : String(error),
                    sessionId: session.id,
                },
            });
            return {
                entry: {
                    expiresAt: this.now() + FAILURE_TTL_MS,
                    key: previous?.key,
                    value: previous?.value,
                },
                lookedUp: true,
            };
        }
    }

    private async resolveSession(
        session: SessionRecord,
        previous: SessionEntry | undefined,
    ): Promise<{ entry: SessionEntry; lookedUp: boolean }> {
        const now = this.now();
        const reference = await this.transcriptReference(session);
        if (reference) {
            const key = pullRequestKey(reference);
            if (previous?.key === key && previous.expiresAt > now)
                return { entry: previous, lookedUp: false };
            const cached = this.pullRequests.get(key);
            if (cached && cached.expiresAt > now)
                return {
                    entry: { expiresAt: cached.expiresAt, key, value: cached.value },
                    lookedUp: false,
                };
            try {
                const value = await this.viewPullRequest(session.rootPath, reference, 'agent');
                const expiresAt = now + this.ttlFor(value);
                rememberBounded(
                    this.pullRequests,
                    key,
                    { expiresAt, value },
                    MAX_PULL_REQUEST_ENTRIES,
                );
                return { entry: { expiresAt, key, value }, lookedUp: true };
            } catch {
                // Transient `gh` failure: keep the last projection and retry after a short back-off.
                const previousValue = previous?.key === key ? previous.value : cached?.value;
                return {
                    entry: { expiresAt: now + FAILURE_TTL_MS, key, value: previousValue },
                    lookedUp: true,
                };
            }
        }
        if (previous && previous.key === undefined && previous.expiresAt > now)
            return { entry: previous, lookedUp: false };
        const branch = await this.branchPullRequest(session);
        return {
            entry: { expiresAt: branch.expiresAt, value: branch.value },
            lookedUp: branch.lookedUp,
        };
    }

    private ttlFor(value: SessionPullRequest | undefined): number {
        if (!value) return this.options.missingTtlMs ?? MISSING_TTL_MS;
        return isSettled(value)
            ? (this.options.settledTtlMs ?? SETTLED_TTL_MS)
            : (this.options.openTtlMs ?? OPEN_TTL_MS);
    }

    private transcriptLocation(
        session: SessionRecord,
    ): Promise<AgentTranscriptLocation | undefined> {
        if (!session.primaryAgentTerminalId) return Promise.resolve(undefined);
        return locateAgentTranscript(
            this.database as CaxriDatabase,
            session.primaryAgentTerminalId,
            this.environment,
        );
    }

    /**
     * Scans only the transcript bytes appended since the previous sweep. The scan keeps PR links and nothing else;
     * prompts and Agent output never leave this method.
     */
    private async transcriptReference(
        session: SessionRecord,
    ): Promise<PullRequestReference | undefined> {
        const location = await this.transcriptLocation(session);
        if (!location) return undefined;
        let scan = this.transcriptScans.get(location.path);
        if (!scan) {
            scan = createTranscriptPullRequestScan();
            rememberBounded(this.transcriptScans, location.path, scan, MAX_TRANSCRIPT_SCANS);
        }
        const current = scan;
        await scanTranscriptLines(
            location,
            current,
            (line) => scanTranscriptPullRequestLine(line, current),
            {
                onReset: () => resetTranscriptPullRequestScan(current),
            },
        );
        /**
         * A `gh pr create` result is authoritative even when it targets a submodule or linked repository. A link the
         * Agent merely mentioned may be anything it quoted (a changelog, a related PR), so it only counts for the
         * repository this Session actually works in; otherwise the sidebar would show a stranger's PR.
         */
        if (current.created) return current.created;
        if (!current.mentioned) return undefined;
        const remote = await this.githubRemote(session);
        return remote &&
            remote.owner.toLowerCase() === current.mentioned.owner.toLowerCase() &&
            remote.repo.toLowerCase() === current.mentioned.repo.toLowerCase()
            ? current.mentioned
            : undefined;
    }

    private async primaryRepository(
        session: SessionRecord,
    ): Promise<GitSummary['repositories'][number] | undefined> {
        const summary = await this.git.summary(session.id, 0, 'pullRequests');
        if (!summary.isRepository) return undefined;
        return summary.repositories.find((candidate) => candidate.kind === 'primary');
    }

    private async githubRemote(session: SessionRecord): Promise<GitHubRemote | undefined> {
        const repo = await this.primaryRepository(session);
        if (!repo || INTEGRATION_BRANCHES.has(repo.branch)) return undefined;
        const remote = await this.optionalGit(repo.rootPath, ['remote', 'get-url', 'origin']);
        const github = remote ? parseGitHubRemote(remote) : undefined;
        return github
            ? {
                  branch: repo.branch,
                  owner: github.owner,
                  repo: github.repo,
                  rootPath: repo.rootPath,
              }
            : undefined;
    }

    private async viewPullRequest(
        cwd: string,
        reference: PullRequestReference,
        source: SessionPullRequest['source'],
    ): Promise<SessionPullRequest | undefined> {
        try {
            const output = await this.github.view({
                cwd,
                number: reference.number,
                owner: reference.owner,
                repo: reference.repo,
            });
            return output
                ? parseSessionPullRequest(output, source, this.ignoredChecks())
                : undefined;
        } catch (error) {
            if (isNoPullRequest(error)) return undefined;
            throw error;
        }
    }

    private async branchPullRequest(
        session: SessionRecord,
    ): Promise<{ expiresAt: number; lookedUp: boolean; value?: SessionPullRequest }> {
        const now = this.now();
        const missing = {
            expiresAt: now + (this.options.missingTtlMs ?? MISSING_TTL_MS),
            lookedUp: false,
        };
        const github = await this.githubRemote(session);
        if (!github) return missing;
        const key = `${github.owner}/${github.repo}\0${github.branch}`;
        const cached = this.branchLookups.get(key);
        if (cached && cached.expiresAt > now)
            return { expiresAt: cached.expiresAt, lookedUp: false, value: cached.value };
        let value: SessionPullRequest | undefined;
        let ttl = this.options.missingTtlMs ?? MISSING_TTL_MS;
        try {
            // A transient failure below keeps the previous branch projection instead of blanking the row.
            const output = await this.runCommand(
                [
                    'pr',
                    'list',
                    '--repo',
                    `${github.owner}/${github.repo}`,
                    // `--head=` keeps an exotic branch name from ever being parsed as another flag.
                    `--head=${github.branch}`,
                    '--state',
                    'all',
                    '--limit',
                    MAX_BRANCH_CANDIDATES,
                    '--json',
                    BRANCH_DISCOVERY_JSON_FIELDS,
                ],
                github.rootPath,
            );
            const candidates = z
                .array(
                    z.looseObject({
                        number: z.number().int().positive(),
                        state: z.string(),
                        isDraft: z.boolean().optional(),
                    }),
                )
                .parse(JSON.parse(output));
            const selected = selectBranchPullRequest(candidates);
            /**
             * Discovery answered _which_ pull request; the shared record answers _what state it is in_, and is the same
             * record the Status panel and status bar read for this repository.
             */
            value = selected
                ? await this.viewPullRequest(
                      github.rootPath,
                      { number: selected.number, owner: github.owner, repo: github.repo },
                      'branch',
                  )
                : undefined;
            ttl = this.ttlFor(value);
        } catch (error) {
            if (!isNoPullRequest(error)) {
                ttl = FAILURE_TTL_MS;
                value = cached?.value;
            }
        }
        const expiresAt = now + ttl;
        rememberBounded(this.branchLookups, key, { expiresAt, value }, MAX_PULL_REQUEST_ENTRIES);
        return { expiresAt, lookedUp: true, value };
    }

    private async optionalGit(
        cwd: string,
        arguments_: readonly string[],
    ): Promise<string | undefined> {
        try {
            return (await this.runner('git', arguments_, cwd)).trim();
        } catch {
            return undefined;
        }
    }

    private async runCommand(arguments_: readonly string[], cwd: string): Promise<string> {
        const startedAt = performance.now();
        const operation = externalStatusCommandOperation('gh', arguments_);
        try {
            const result = await this.runner('gh', arguments_, cwd);
            this.logger.write('debug', logEventCatalog.sessionPullRequests.cli, {
                durationMs: performance.now() - startedAt,
                fields: { operation, result: 'success' },
            });
            return result;
        } catch (error) {
            const failureKind =
                error instanceof ExternalStatusCliError ? error.kind : ('other' as const);
            this.logger.write(
                isNoPullRequest(error) ? 'debug' : 'warn',
                logEventCatalog.sessionPullRequests.cli,
                {
                    durationMs: performance.now() - startedAt,
                    fields: { operation, result: 'failure', failureKind },
                },
            );
            throw error;
        }
    }

    /**
     * Returns the last settled projection immediately and refreshes stale Sessions in the background; the
     * `sessionPullRequests.changed` event owns UI convergence.
     */
    snapshot(): SessionPullRequests {
        this.expireOnIgnoredChecksChange();
        const now = this.now();
        const pullRequests: SessionPullRequests['pullRequests'] = {};
        let isStale = false;
        for (const session of this.activeSessions()) {
            const entry = this.sessions.get(session.id);
            if (!entry || entry.expiresAt <= now) isStale = true;
            if (entry?.value) pullRequests[session.id] = entry.value;
        }
        if (isStale) {
            // Fire-and-forget: the sweep logs its own failure and emits the change event.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void this.refresh();
        }
        return { pullRequests, refreshedAt: this.refreshedAt };
    }

    async refresh(): Promise<void> {
        if (this.sweep) {
            await this.sweep;
            return;
        }
        this.sweep = this.runSweep();
        try {
            await this.sweep;
        } finally {
            this.sweep = undefined;
        }
    }
}

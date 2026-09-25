import type {
    AppSettings,
    GitSummary,
    PullRequestUnavailable,
    ServerEvent,
    SessionDeployment,
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
    agentProviderStateRoot,
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
    ExternalStatusCommandTelemetry,
    GitHubPullRequestStore,
    isNoPullRequest,
    pullRequestUnavailable,
    runExternalStatusCommand,
} from './external-status';
import type { GitService } from './git';
import { VercelDeploymentStore } from './project-status-vercel-store';
import { resolveSessionDeployment } from './session-pull-request-deployment';
import { parseSessionPullRequest, selectBranchPullRequest } from './session-pull-request-parse';

/**
 * Merge state moves on human timescales, so an open PR refreshes once a minute while a merged or closed one only
 * re-confirms every fifteen minutes. A branch with no PR is re-queried every five minutes: the Agent usually opens the
 * PR from inside its own transcript, which the cheap local scan catches on the next sweep without any `gh` call.
 */
const OPEN_TTL_MS = 60_000;
const SETTLED_TTL_MS = 15 * 60_000;
const MISSING_TTL_MS = 5 * 60_000;
/**
 * A failed lookup retries on the status-bar's minute cadence so recovery clears the unknown state automatically.
 * Rate-limited calls still use the source-level circuit breaker to avoid wasteful requests.
 */
const FAILURE_TTL_MS = 60_000;
const MAX_CONCURRENT_LOOKUPS = 4;
/**
 * How old a shared pull-request record a forced Session refresh still accepts. The focus refresh re-reads the Status
 * panel first, which refetches the same pull request moments earlier; accepting that record avoids paying a second `gh
 * pr view` for it while still rejecting anything fetched before the window regained focus.
 */
const FORCED_RECORD_MAX_AGE_MS = 5_000;
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
    unavailable?: PullRequestUnavailable;
}

interface SessionEntry {
    expiresAt: number;
    /**
     * Identity of the transcript reference this entry was resolved from, so a transcript that switches PRs invalidates
     * immediately. Absent when the entry came from branch discovery alone. It is not always the identity of `value`:
     * once the transcript's pull request is settled, a different one found on the Session's branch takes the row while
     * the key keeps tracking the transcript that must still invalidate it.
     */
    key?: string;
    value?: SessionPullRequest;
    unavailable?: PullRequestUnavailable;
}

interface ScopedSessionEntry extends SessionEntry {
    context: string;
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
    /**
     * Server-wide Vercel projection shared with the Status panel, so one production query serves every Session pointing
     * at the same repository.
     */
    vercel?: VercelDeploymentStore;
}

type SessionPullRequestDatabase = Pick<
    CaxriDatabase,
    'getSession' | 'getTerminal' | 'listVisibleSessions'
>;

function pullRequestKey(reference: PullRequestReference): string {
    return `${reference.owner}/${reference.repo}#${reference.number}`;
}

function isSettled(value: SessionPullRequest | undefined): value is SessionPullRequest {
    return value?.state === 'merged' || value?.state === 'closed';
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
    private readonly sessions = new Map<string, ScopedSessionEntry>();
    private sweep?: Promise<void>;
    private isRefreshRequested = false;
    /**
     * Sessions whose next sweep must bypass every cached lookup (see {@link refreshSession}). Consumed by the sweep that
     * resolves the Session, so one request forces exactly one lookup.
     */
    private readonly forcedSessionIds = new Set<string>();
    private readonly transcriptScans = new Map<string, TranscriptPullRequestScan>();
    private readonly github: GitHubPullRequestStore;
    private readonly vercel: VercelDeploymentStore;
    /**
     * Undefined until the first snapshot. Reading settings from the constructor would make merely assembling the Server
     * depend on configuration being loaded, which it is not obliged to be at that point.
     */
    private ignoredChecksSignature?: string;
    private readonly commandTelemetry: ExternalStatusCommandTelemetry;

    constructor(
        private readonly database: SessionPullRequestDatabase,
        private readonly git: Pick<GitService, 'summary'>,
        private readonly logger: StructuredLogger,
        private readonly runner: ExternalStatusRunner = runExternalStatusCommand,
        private readonly options: SessionPullRequestServiceOptions = {},
    ) {
        this.environment = options.agentEnvironment ?? defaultAgentEnvironment();
        this.now = options.now ?? Date.now;
        const { cli } = logEventCatalog.sessionPullRequests;
        this.commandTelemetry = new ExternalStatusCommandTelemetry(logger, cli, () => this.now());
        this.github =
            options.github ?? new GitHubPullRequestStore(this.runner, { now: () => this.now() });
        this.vercel =
            options.vercel ?? new VercelDeploymentStore(this.runner, { now: () => this.now() });
    }

    /**
     * Root and in-place Agent rebinding invalidate discovery without changing the cached PR's TTL.
     */
    private discoveryContext(session: SessionRecord): string {
        const terminal = session.primaryAgentTerminalId
            ? this.database.getTerminal(session.primaryAgentTerminalId)
            : undefined;
        return JSON.stringify([
            session.rootPath,
            session.workbenchProjectId,
            session.primaryAgentTerminalId,
            terminal?.provider,
            terminal?.agentSessionId,
            terminal ? agentProviderStateRoot(terminal) : undefined,
        ]);
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
        return this.database
            .listVisibleSessions()
            .filter((session) => session.archivedAt === undefined);
    }

    private async runSweep(): Promise<boolean> {
        const startedAt = performance.now();
        const changed: string[] = [];
        let lookups = 0;
        let isContextChanged = false;
        try {
            const sessions = this.activeSessions();
            const liveIds = new Set(sessions.map((session) => session.id));
            for (const sessionId of this.sessions.keys())
                if (!liveIds.has(sessionId)) this.sessions.delete(sessionId);
            for (const sessionId of this.forcedSessionIds)
                if (!liveIds.has(sessionId)) this.forcedSessionIds.delete(sessionId);
            await mapWithConcurrency(sessions, MAX_CONCURRENT_LOOKUPS, async (session) => {
                const context = this.discoveryContext(session);
                const cached = this.sessions.get(session.id);
                const previous = cached?.context === context ? cached : undefined;
                const isForced = this.forcedSessionIds.delete(session.id);
                const resolved = await this.resolveSessionSafely(session, previous, isForced);
                const result = { ...resolved, entry: await this.withDeployment(session, resolved) };
                if (result.lookedUp) lookups += 1;
                const current = this.database.getSession(session.id);
                if (!current || current.archivedAt !== undefined) return;
                if (this.discoveryContext(current) !== context) {
                    // An old asynchronous lookup must never overwrite a newly selected root's projection.
                    isContextChanged = true;
                    return;
                }
                this.sessions.set(session.id, { ...result.entry, context });
                if (
                    result.entry.value?.state !== previous?.value?.state ||
                    result.entry.value?.checks !== previous?.value?.checks ||
                    result.entry.value?.url !== previous?.value?.url ||
                    result.entry.value?.deployment?.state !== previous?.value?.deployment?.state ||
                    result.entry.unavailable?.reason !== previous?.unavailable?.reason
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
        return isContextChanged;
    }

    /**
     * Adds the production deployment this Session's merged pull request produced, when production is currently serving
     * exactly that merge commit.
     *
     * Run on every sweep rather than only on a lookup, because the deployment lands minutes after the merge that a
     * settled entry then caches for a quarter of an hour. While a merged pull request has no matching deployment the
     * entry is also held to the open cadence, so the badge appears when the build finishes instead of whenever the next
     * unrelated change happens to expire the row.
     */
    private async withDeployment(
        session: SessionRecord,
        resolved: { entry: SessionEntry },
    ): Promise<SessionEntry> {
        const entry = resolved.entry;
        if (entry.value?.state !== 'merged') return entry;
        let deployment: SessionDeployment | undefined;
        try {
            deployment = await resolveSessionDeployment(
                { github: this.github, vercel: this.vercel },
                entry.value,
                session.rootPath,
            );
        } catch (error) {
            // The badge is additive, so an unreachable provider leaves the row exactly as the pull request lookup left
            // it rather than failing the Session's whole projection.
            this.logger.write('debug', logEventCatalog.sessionPullRequests.refreshFailed, {
                fields: {
                    message: error instanceof Error ? error.message : String(error),
                    sessionId: session.id,
                },
            });
        }
        // Always rewritten, so a badge never outlives the build it described: the next merge moves production onto
        // another commit, and this row must go back to reporting a plain merge.
        if (deployment) return { ...entry, value: { ...entry.value, deployment } };
        return {
            ...entry,
            expiresAt: Math.min(
                entry.expiresAt,
                this.now() + (this.options.openTtlMs ?? OPEN_TTL_MS),
            ),
            value: { ...entry.value, deployment: undefined },
        };
    }

    /**
     * `mapWithConcurrency` fails fast, so one Session with a broken checkout (deleted root, unreadable `.git`) would
     * otherwise starve every Session queued behind it on every sweep. Keep that Session's last projection, retry it
     * after the failure back-off, and let the rest of the sweep continue.
     */
    private async resolveSessionSafely(
        session: SessionRecord,
        previous: SessionEntry | undefined,
        isForced: boolean,
    ): Promise<{ entry: SessionEntry; lookedUp: boolean }> {
        try {
            return await this.resolveSession(session, previous, isForced);
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
        isForced: boolean,
    ): Promise<{ entry: SessionEntry; lookedUp: boolean }> {
        const now = this.now();
        const reference = await this.transcriptReference(session);
        if (reference) {
            const key = pullRequestKey(reference);
            // A still-fresh entry already carries last sweep's answer, including any branch hand-off below.
            if (!isForced && previous?.key === key && previous.expiresAt > now)
                return { entry: previous, lookedUp: false };
            const transcript = await this.transcriptPullRequest(
                session,
                reference,
                key,
                previous,
                isForced,
            );
            return this.preferBranchPullRequest(session, transcript, key, isForced);
        }
        if (!isForced && previous && previous.key === undefined && previous.expiresAt > now)
            return { entry: previous, lookedUp: false };
        const branch = await this.branchPullRequest(session, isForced);
        return {
            entry: {
                expiresAt: branch.expiresAt,
                value: branch.value,
                unavailable: branch.unavailable,
            },
            lookedUp: branch.lookedUp,
        };
    }

    /**
     * Resolves the pull request the Session's own Agent transcript points at, through the Server-wide record cache.
     */
    private async transcriptPullRequest(
        session: SessionRecord,
        reference: PullRequestReference,
        key: string,
        previous: SessionEntry | undefined,
        isForced: boolean,
    ): Promise<{ entry: SessionEntry; lookedUp: boolean }> {
        const now = this.now();
        const cached = this.pullRequests.get(key);
        if (!isForced && cached && cached.expiresAt > now)
            return {
                entry: { expiresAt: cached.expiresAt, key, value: cached.value },
                lookedUp: false,
            };
        try {
            const value = await this.viewPullRequest(
                session.rootPath,
                reference,
                'agent',
                isForced,
            );
            const expiresAt = now + this.ttlFor(value);
            rememberBounded(this.pullRequests, key, { expiresAt, value }, MAX_PULL_REQUEST_ENTRIES);
            return { entry: { expiresAt, key, value }, lookedUp: true };
        } catch (error) {
            // Transient `gh` failure: keep the last projection and retry after a short back-off.
            const previousValue = previous?.key === key ? previous.value : cached?.value;
            const unavailable = pullRequestUnavailable(error);
            this.logger.write('warn', logEventCatalog.sessionPullRequests.lookupUnavailable, {
                fields: { reason: unavailable.reason },
            });
            return {
                entry: {
                    expiresAt: now + FAILURE_TTL_MS,
                    key,
                    value: previousValue,
                    unavailable,
                },
                lookedUp: true,
            };
        }
    }

    /**
     * Hands the row to the current branch's pull request once the transcript's own one is merged or closed.
     *
     * The transcript scan can only see `gh pr create` calls made inside that one transcript, so a Session whose next
     * pull request was opened from another conversation — or whose worktree simply moved to a new branch — keeps
     * pointing at the delivery that already landed. The Session row then contradicts the status bar, which has always
     * queried by branch (issue #1035).
     *
     * Only a _different_ pull request takes over. A branch with none, or with the same one, keeps the transcript's
     * answer so a pull request merged thirty seconds ago does not blank the row before its successor exists, and a
     * failed branch lookup is discarded rather than surfaced, because an error badge over a perfectly good projection
     * would be worse than the staleness this repairs. The extra query is paid only by settled pull requests, whose own
     * fifteen-minute TTL is what made the stale row survive so long.
     */
    private async preferBranchPullRequest(
        session: SessionRecord,
        transcript: { entry: SessionEntry; lookedUp: boolean },
        key: string,
        isForced: boolean,
    ): Promise<{ entry: SessionEntry; lookedUp: boolean }> {
        const settled = transcript.entry.value;
        if (!isSettled(settled)) return transcript;
        const branch = await this.branchPullRequest(session, isForced);
        const expiresAt = Math.min(transcript.entry.expiresAt, branch.expiresAt);
        const lookedUp = transcript.lookedUp || branch.lookedUp;
        if (!branch.value || branch.value.url === settled.url)
            return { entry: { ...transcript.entry, expiresAt }, lookedUp };
        return { entry: { expiresAt, key, value: branch.value }, lookedUp };
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
        isForced: boolean,
    ): Promise<SessionPullRequest | undefined> {
        try {
            const output = await this.github.view({
                allowStaleOnFailure: false,
                cwd,
                maxAgeMs: isForced ? FORCED_RECORD_MAX_AGE_MS : undefined,
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
        isForced: boolean,
    ): Promise<{
        expiresAt: number;
        lookedUp: boolean;
        value?: SessionPullRequest;
        unavailable?: PullRequestUnavailable;
    }> {
        const now = this.now();
        const missing = {
            expiresAt: now + (this.options.missingTtlMs ?? MISSING_TTL_MS),
            lookedUp: false,
        };
        const github = await this.githubRemote(session);
        if (!github) return missing;
        const key = `${github.owner}/${github.repo}\0${github.branch}`;
        const cached = this.branchLookups.get(key);
        if (!isForced && cached && cached.expiresAt > now)
            return {
                expiresAt: cached.expiresAt,
                lookedUp: false,
                value: cached.value,
                unavailable: cached.unavailable,
            };
        let value: SessionPullRequest | undefined;
        let unavailable: PullRequestUnavailable | undefined;
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
                      isForced,
                  )
                : undefined;
            ttl = this.ttlFor(value);
        } catch (error) {
            if (!isNoPullRequest(error)) {
                ttl = FAILURE_TTL_MS;
                value = cached?.value;
                unavailable = pullRequestUnavailable(error);
                this.logger.write('warn', logEventCatalog.sessionPullRequests.lookupUnavailable, {
                    fields: { reason: unavailable.reason },
                });
            }
        }
        const expiresAt = now + ttl;
        rememberBounded(
            this.branchLookups,
            key,
            { expiresAt, value, unavailable },
            MAX_PULL_REQUEST_ENTRIES,
        );
        return { expiresAt, lookedUp: true, value, unavailable };
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
        return this.commandTelemetry.observe({
            command: 'gh',
            arguments: arguments_,
            run: () => this.runner('gh', arguments_, cwd),
        });
    }

    private async refreshUntilCurrent(): Promise<void> {
        let isContextChanged: boolean;
        do {
            this.consumeRefreshRequest();
            // Root changes discovered during lookup must settle before a replacement sweep starts.
            // eslint-disable-next-line no-await-in-loop
            const changedDuringLookup = await this.runSweep();
            isContextChanged = this.consumeRefreshRequest() || changedDuringLookup;
        } while (isContextChanged);
    }

    private consumeRefreshRequest(): boolean {
        const requested = this.isRefreshRequested;
        this.isRefreshRequested = false;
        return requested;
    }

    /**
     * Returns the last settled projection immediately and refreshes stale Sessions in the background; the
     * `sessionPullRequests.changed` event owns UI convergence.
     */
    snapshot(): SessionPullRequests {
        this.expireOnIgnoredChecksChange();
        const now = this.now();
        const pullRequests: SessionPullRequests['pullRequests'] = {};
        const unavailable: NonNullable<SessionPullRequests['unavailable']> = {};
        let isStale = false;
        for (const session of this.activeSessions()) {
            const cached = this.sessions.get(session.id);
            const entry = cached?.context === this.discoveryContext(session) ? cached : undefined;
            if (!entry || entry.expiresAt <= now) isStale = true;
            if (entry?.value) pullRequests[session.id] = entry.value;
            if (entry?.unavailable) unavailable[session.id] = entry.unavailable;
        }
        if (isStale) {
            // Fire-and-forget: the sweep logs its own failure and emits the change event.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void this.refresh();
        }
        return {
            pullRequests,
            ...(Object.keys(unavailable).length > 0 && { unavailable }),
            refreshedAt: this.refreshedAt,
        };
    }

    /**
     * Re-resolves one Session past every cache this service and the shared pull-request record hold, then publishes the
     * result through `sessionPullRequests.changed` like any sweep. Other Sessions ride along on their normal TTLs. A
     * sweep already in flight may have resolved this Session before the request arrived, so the request also asks that
     * sweep to run once more.
     */
    async refreshSession(sessionId: string): Promise<void> {
        this.forcedSessionIds.add(sessionId);
        this.isRefreshRequested = true;
        await this.refresh();
    }

    async refresh(): Promise<void> {
        if (this.sweep) {
            // A Session may have settled before another lookup; preserve requests that invalidate that earlier result.
            if (
                this.activeSessions().some(
                    (session) =>
                        this.sessions.get(session.id)?.context !== this.discoveryContext(session),
                )
            )
                this.isRefreshRequested = true;
            await this.sweep;
            return;
        }
        this.sweep = this.refreshUntilCurrent();
        try {
            await this.sweep;
        } finally {
            this.sweep = undefined;
        }
    }
}

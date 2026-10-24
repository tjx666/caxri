import type {
    AppSettings,
    GitSummary,
    PullRequestUnavailable,
    ServerEvent,
    SessionPullRequest,
    SessionPullRequests,
    SessionRecord,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, mapWithConcurrency, SingleFlight } from '@caxri/system';
import { parseGitHubRemote, rememberBounded } from '@caxri/utils';
import { z } from 'zod';

import type { AgentEnvironment } from '../agents';
import { agentProviderStateRoot, defaultAgentEnvironment } from '../agents';
import type { CaxriDatabase } from '../db';
import type { ExternalStatusRunner } from '../external-status';
import {
    ExternalStatusCommandTelemetry,
    GitHubPullRequestStore,
    isNoPullRequest,
    pullRequestUnavailable,
    runExternalStatusCommand,
} from '../external-status';
import type { GitService } from '../git';
import type { SessionTranscriptContext } from '../session';
import { SessionContextService } from '../session';
import { withSessionDeployment } from './session-pull-request-deployment';
import type {
    BranchLookupEntry,
    GitHubRemote,
    PullRequestEntry,
    PullRequestReference,
    ScopedSessionEntry,
    SessionEntry,
    SessionUpdate,
} from './session-pull-request-entries';
import { isSettled, pullRequestKey, wasMergedBefore } from './session-pull-request-entries';
import type { SessionPullRequestResolution } from './session-pull-request-parse';
import {
    isRowChanged,
    parseSessionPullRequest,
    selectBranchPullRequest,
} from './session-pull-request-parse';
import { VercelDeploymentStore } from './vercel-store';

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
    /**
     * Hears each Session whose resolved pull request changed lifecycle state or identity, with the previous projection
     * (absent the first time this Server Core resolved the Session, so a pull request that was already merged before
     * Caxri started never reads as a fresh merge). Called synchronously after the projection is stored; a throwing
     * listener never fails the sweep.
     */
    onPullRequestChanged?: (
        sessionId: string,
        previous: SessionPullRequest | undefined,
        next: SessionPullRequest | undefined,
    ) => void;
    openTtlMs?: number;
    settledTtlMs?: number;
    missingTtlMs?: number;
    /**
     * Reads the Session's transcript clues, shared with every other clue consumer so a transcript is scanned once.
     * Without it the Service scans through a private reader.
     */
    sessionContext?: (session: SessionRecord) => Promise<SessionTranscriptContext>;
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

/**
 * Discovers and tracks the pull request each active Session is delivering. Discovery prefers the Session's own Agent
 * transcript (the Agent may have opened the PR from a throwaway worktree that the Workbench root never checked out),
 * then falls back to the Workbench root's checked-out branch. State comes from the `gh` CLI with fixed argv, so no
 * token handling or network client lives in Caxri. One background sweep serves every sidebar row; the Renderer never
 * issues per-Session delivery queries.
 */
export class SessionPullRequestService {
    private readonly branchLookups = new Map<string, BranchLookupEntry>();
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
    private readonly readSessionContext: (
        session: SessionRecord,
    ) => Promise<SessionTranscriptContext>;
    /**
     * Keyed by Session id, so a sweep and a {@link resolve} for the same Session share one lookup instead of racing two
     * `gh` calls whose later answer could overwrite the fresher one.
     */
    private readonly updates = new SingleFlight<string, SessionUpdate>();
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
        this.now = options.now ?? Date.now;
        this.readSessionContext = options.sessionContext ?? this.privateSessionContext();
        const { cli } = logEventCatalog.sessionPullRequests;
        this.commandTelemetry = new ExternalStatusCommandTelemetry(logger, cli, () => this.now());
        this.github =
            options.github ?? new GitHubPullRequestStore(this.runner, { now: () => this.now() });
        this.vercel =
            options.vercel ?? new VercelDeploymentStore(this.runner, { now: () => this.now() });
    }

    private privateSessionContext(): (session: SessionRecord) => Promise<SessionTranscriptContext> {
        const environment = this.options.agentEnvironment ?? defaultAgentEnvironment();
        const database = this.database as CaxriDatabase;
        const reader = new SessionContextService(database, this.logger, environment);
        return (session) => reader.read(session);
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
                const { isJoined, update } = await this.runUpdate(session);
                if (!isJoined && update.lookedUp) lookups += 1;
                if (update.outcome === 'rebound') isContextChanged = true;
                // A joined update belongs to the caller that started it, which also announces its change.
                else if (!isJoined && update.outcome === 'changed') changed.push(session.id);
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
        if (changed.length > 0) this.announce(changed);
        return isContextChanged;
    }

    private announce(sessionIds: string[]): void {
        this.options.emit?.({ event: 'sessionPullRequests.changed', payload: { sessionIds } });
    }

    /**
     * A forced request is consumed when the update starts, so a forced sweep and a {@link resolve} join one lookup; one
     * added after that start stays queued for the re-sweep it requested.
     */
    private async runUpdate(
        session: SessionRecord,
    ): Promise<{ isJoined: boolean; update: SessionUpdate }> {
        const isJoined = this.updates.has(session.id);
        const update = await this.updates.run(session.id, () =>
            this.updateSession(session, this.forcedSessionIds.delete(session.id)),
        );
        return { isJoined, update };
    }

    /**
     * Resolves one Session and stores its projection, unless the Session was archived, deleted, or rebound while the
     * lookup ran: an old asynchronous lookup must never overwrite a newly selected root's projection.
     */
    private async updateSession(session: SessionRecord, isForced: boolean): Promise<SessionUpdate> {
        const context = this.discoveryContext(session);
        const cached = this.sessions.get(session.id);
        const previous = cached?.context === context ? cached : undefined;
        const resolved = await this.resolveSessionSafely(session, previous, isForced);
        const entry = await withSessionDeployment(
            { github: this.github, vercel: this.vercel },
            resolved.entry,
            {
                openExpiresAt: this.now() + (this.options.openTtlMs ?? OPEN_TTL_MS),
                rootPath: session.rootPath,
                // The badge is additive, so an unreachable provider leaves the row as the lookup left it.
                onError: (error) =>
                    this.logger.write('debug', logEventCatalog.sessionPullRequests.refreshFailed, {
                        fields: {
                            message: error instanceof Error ? error.message : String(error),
                            sessionId: session.id,
                        },
                    }),
            },
        );
        const { lookedUp } = resolved;
        const current = this.database.getSession(session.id);
        if (!current || current.archivedAt !== undefined) return { lookedUp, outcome: 'gone' };
        if (this.discoveryContext(current) !== context) return { lookedUp, outcome: 'rebound' };
        this.sessions.set(session.id, { ...entry, context });
        this.notifyPullRequestChanged(session.id, previous?.value, entry.value);
        return { lookedUp, outcome: isRowChanged(entry, previous) ? 'changed' : 'unchanged' };
    }

    private notifyPullRequestChanged(
        sessionId: string,
        previous: SessionPullRequest | undefined,
        next: SessionPullRequest | undefined,
    ): void {
        if (previous?.state === next?.state && previous?.url === next?.url) return;
        try {
            this.options.onPullRequestChanged?.(sessionId, previous, next);
        } catch (error) {
            this.logger.write('warn', logEventCatalog.sessionPullRequests.refreshFailed, {
                fields: { message: error instanceof Error ? error.message : String(error) },
            });
        }
    }

    /**
     * The stored projection, provided it was computed for the Session's current root and Agent.
     */
    private currentEntry(session: SessionRecord): ScopedSessionEntry | undefined {
        const cached = this.sessions.get(session.id);
        return cached?.context === this.discoveryContext(session) ? cached : undefined;
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
        const found = await this.transcriptReference(session);
        let isTranscriptLookedUp = false;
        if (found) {
            const key = pullRequestKey(found.reference);
            // A still-fresh entry already carries last sweep's answer, including any branch hand-off below.
            if (!isForced && previous?.key === key && previous.expiresAt > now)
                return { entry: previous, lookedUp: false };
            const transcript = await this.transcriptPullRequest(
                session,
                found.reference,
                key,
                previous,
                isForced,
            );
            if (!(found.isMentioned && wasMergedBefore(transcript.entry.value, session.createdAt)))
                return this.preferBranchPullRequest(session, transcript, key, isForced);
            // The Agent cited a delivery that landed before this Session existed; fall back to the branch.
            isTranscriptLookedUp = transcript.lookedUp;
        }
        if (!isForced && previous && previous.key === undefined && previous.expiresAt > now)
            return { entry: previous, lookedUp: isTranscriptLookedUp };
        const branch = await this.branchPullRequest(session, isForced);
        return {
            entry: {
                expiresAt: branch.expiresAt,
                value: branch.value,
                unavailable: branch.unavailable,
            },
            lookedUp: branch.lookedUp || isTranscriptLookedUp,
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
     * pull request was opened from another conversation (or whose worktree simply moved to a new branch) keeps pointing
     * at the delivery that already landed. The Session row then contradicts the status bar, which has always queried by
     * branch (issue #1035).
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

    /**
     * The pull request the Session's own transcript points at. The shared reader scans only the bytes appended since
     * any consumer's previous visit and keeps PR links and nothing else of the conversation.
     */
    private async transcriptReference(
        session: SessionRecord,
    ): Promise<{ reference: PullRequestReference; isMentioned: boolean } | undefined> {
        const { pullRequests: current } = await this.readSessionContext(session);
        /**
         * A `gh pr create` result is authoritative even when it targets a submodule or linked repository. A link the
         * Agent merely mentioned may be anything it quoted (a changelog, a related PR), so it only counts for the
         * repository this Session actually works in; otherwise the sidebar would show a stranger's PR.
         */
        if (current.created) return { reference: current.created, isMentioned: false };
        if (!current.mentioned) return undefined;
        const remote = await this.githubRemote(session);
        return remote &&
            remote.owner.toLowerCase() === current.mentioned.owner.toLowerCase() &&
            remote.repo.toLowerCase() === current.mentioned.repo.toLowerCase()
            ? { reference: current.mentioned, isMentioned: true }
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
            const entry = this.currentEntry(session);
            if (!entry || entry.expiresAt <= now) isStale = true;
            if (entry?.value) pullRequests[session.id] = entry.value;
            if (entry?.unavailable) unavailable[session.id] = entry.unavailable;
        }
        if (isStale) {
            // Fire-and-forget: the sweep logs its own failure and emits the change event.
            void this.refresh();
        }
        return {
            pullRequests,
            ...(Object.keys(unavailable).length > 0 && { unavailable }),
            refreshedAt: this.refreshedAt,
        };
    }

    /**
     * The pull request this Session delivers, by the rule its sidebar row uses, so the status bar and the Status panel
     * cannot name a different one. A fresh projection answers immediately; otherwise only this Session is resolved
     * (sharing any sweep already on it), so the status bar never waits behind other Sessions' lookups.
     *
     * `undefined` means this service does not track the Session (archived, unknown, or rebound mid-lookup).
     */
    async resolve(sessionId: string): Promise<SessionPullRequestResolution | undefined> {
        this.expireOnIgnoredChecksChange();
        const session = this.database.getSession(sessionId);
        if (!session || session.archivedAt !== undefined) return undefined;
        let entry = this.currentEntry(session);
        /**
         * A failed lookup is re-asked on every status bar poll, not held for its failure TTL, so a signed-in `gh`
         * clears the indicator on the next poll. The limiter still refuses calls while GitHub's rate limit is paused.
         */
        if (entry?.unavailable) this.forcedSessionIds.add(sessionId);
        if (!entry || entry.unavailable || entry.expiresAt <= this.now()) {
            const { isJoined, update } = await this.runUpdate(session);
            if (!isJoined && update.outcome === 'changed') this.announce([sessionId]);
            entry = update.outcome === 'rebound' ? undefined : this.currentEntry(session);
        }
        if (!entry) return undefined;
        return {
            ...(entry.value && { value: entry.value }),
            ...(entry.unavailable && { unavailable: entry.unavailable }),
        };
    }

    /**
     * Re-resolves the given Sessions past every cache this service and the shared pull-request record hold, then
     * publishes the result through `sessionPullRequests.changed` like any sweep. Other Sessions ride along on their
     * normal TTLs. A sweep already in flight may have resolved them before the request arrived, so the request also
     * asks that sweep to run once more.
     */
    async refreshSession(...sessionIds: string[]): Promise<void> {
        for (const sessionId of sessionIds) this.forcedSessionIds.add(sessionId);
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

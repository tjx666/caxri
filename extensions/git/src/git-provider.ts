import type {
    CancellationToken,
    CaxriApi,
    GitCommitDetails,
    GitPullRequestChanges,
    GitRepositorySummary,
    SourceControlActionResult,
    SourceControlChange,
    SourceControlHistoryDetails,
    SourceControlHistoryPage,
    SourceControlProvider,
    SourceControlViewModel,
} from 'caxri';
import caxri, { CancellationTokenSource, EventEmitter, GitPullRequestErrorMessage } from 'caxri';

import { DetailQueue } from './detail-queue';
import { canDetectPullRequest, shouldAutoSelectPullRequestMode } from './pull-request-detection';
import {
    buildSourceControlHistoryDetails,
    buildSourceControlHistoryPage,
} from './source-control-history';
import type {
    ActionRegistration,
    GitSourceControlMode,
    RegisterSourceControlAction,
} from './source-control-model';
import { buildSourceControlViewModel } from './source-control-model';
import { boundSourceControlViewModel } from './source-control-payload';

interface RegisteredAction {
    command: ActionRegistration['command'];
    revision: string;
}

interface DetailState<Value> {
    errorMessage?: string;
    cancellation: CancellationTokenSource;
    identity?: string;
    key: string;
    status: 'error' | 'loading' | 'ready';
    value?: Value;
}

interface GitProviderScopeState {
    actions: Map<string, RegisteredAction>;
    avatarHosts: Map<string, string | null>;
    commitDetails: Map<string, DetailState<GitCommitDetails>>;
    commitOpenSequence: number;
    commitSelection?: { repositoryId: string; sha: string };
    contentTimer?: ReturnType<typeof setTimeout>;
    diffExclude: Readonly<Record<string, boolean>>;
    /**
     * Whether this scope's mode is settled: a mode command, opening a commit, a Renderer request that changes the mode
     * the provider last returned, or a first request restoring a persisted mode (reopening in Working Tree mode must
     * land there). Until then, a clean Working Tree scope moves to Pull Request mode once any repository's branch has a
     * pull request (see `shouldAutoSelectPullRequestMode`).
     */
    isModeChosen: boolean;
    /**
     * Whether `provideView` has returned a model yet, which makes a later differing `preferredModeId` a user choice.
     */
    hasProvidedView: boolean;
    mode: GitSourceControlMode;
    pullRequests: Map<string, DetailState<GitPullRequestChanges | null>>;
    repositories: Map<string, GitRepositorySummary>;
    actionSequence: number;
    revision: string;
    revisionSequence: number;
    refreshSequence: number;
    isShowingExcluded: boolean;
    /**
     * Server-facing refresh nonce. Only a user-initiated refresh (panel Refresh, Sync, Discard, or the
     * `caxri.git.refresh` command) advances it; watcher-driven and active-context re-reads keep the previous value so
     * the Server joins its current generation instead of forcing a parallel full re-discovery on every `git.changed`
     * (#584).
     */
    forceSequence: number;
    /**
     * `forceSequence` value most recently handed to `git.pullRequestChanges`, per repository. Unlike `git.summary`, the
     * Server treats any nonzero `refresh` there as an unconditional cache bypass, so the provider must send the nonce
     * once per user action and fall back to `0` for every later watcher-driven re-read.
     */
    pullRequestForcedSequences: Map<string, number>;
}

const CONTENT_CHANGE_BATCH_MS = 50;

type GitWorkspaceApi = Pick<CaxriApi['workspace'], 'getConfiguration' | 'git'>;

function providerError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function assertNotCancelled(token: CancellationToken): void {
    if (token.isCancellationRequested)
        throw providerError('CANCELLED', 'Source Control request was cancelled');
}

function isMode(value: string | undefined): value is GitSourceControlMode {
    return ['working', 'commit', 'pull-request'].includes(value ?? '');
}

/**
 * Owns Git product state and projects Runtime's authorized raw domain results into the controlled Source Control
 * contract. Renderer action invocation uses opaque, revision-bound ids; the generic surface never interprets the
 * provider command binding or its arguments.
 */
export class GitProvider implements SourceControlProvider {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly changed = new EventEmitter<SourceControlChange>();
    private readonly detailQueue = new DetailQueue();
    private disposed = false;
    private readonly scopes = new Map<string, GitProviderScopeState>();

    readonly onDidChange = this.changed.event;

    constructor(private readonly workspace: GitWorkspaceApi = caxri.workspace) {}

    private stateFor(scopeId: string): GitProviderScopeState {
        const current = this.scopes.get(scopeId);
        if (current) return current;
        const state: GitProviderScopeState = {
            actions: new Map(),
            avatarHosts: new Map(),
            commitDetails: new Map(),
            commitOpenSequence: 0,
            diffExclude: {},
            hasProvidedView: false,
            isModeChosen: false,
            mode: 'working',
            pullRequests: new Map(),
            pullRequestForcedSequences: new Map(),
            repositories: new Map(),
            actionSequence: 0,
            forceSequence: 0,
            refreshSequence: 0,
            revision: '0',
            revisionSequence: 0,
            isShowingExcluded: false,
        };
        this.scopes.set(scopeId, state);
        return state;
    }

    private nextRevision(state: GitProviderScopeState): string {
        state.revision = String(++state.revisionSequence);
        state.actions.clear();
        state.avatarHosts.clear();
        state.repositories.clear();
        return state.revision;
    }

    private registerActionFor(state: GitProviderScopeState): RegisterSourceControlAction {
        return (action) => {
            const id = `action-${++state.actionSequence}`;
            state.actions.set(id, { command: action.command, revision: state.revision });
            return { id, ...action };
        };
    }

    private clearDetails(state: GitProviderScopeState, shouldPreserveSettled = false): void {
        if (state.contentTimer) clearTimeout(state.contentTimer);
        state.contentTimer = undefined;
        for (const detail of [...state.commitDetails.values(), ...state.pullRequests.values()]) {
            detail.cancellation.cancel();
            detail.cancellation.dispose();
        }
        if (shouldPreserveSettled) {
            /**
             * Keep settled content visible while a replacement request runs in the same repository context. Blanking
             * the key alone re-queues the request; each loader decides whether its own `identity` still matches and so
             * whether the old value may stay on screen meanwhile (#584). Dropping the entries instead made every
             * watcher-driven refresh repaint the panel as empty and then back, which read as a periodic flash.
             */
            for (const detail of [...state.commitDetails.values(), ...state.pullRequests.values()])
                detail.key = '';
        } else {
            state.commitDetails.clear();
            state.pullRequests.clear();
        }
    }

    private scheduleContentChange(state: GitProviderScopeState): void {
        if (this.disposed || state.contentTimer) return;
        state.contentTimer = setTimeout(() => {
            state.contentTimer = undefined;
            if (!this.disposed) this.changed.fire({ kind: 'content' });
        }, CONTENT_CHANGE_BATCH_MS);
    }

    private pruneDetails(state: GitProviderScopeState, repoIds: ReadonlySet<string>): void {
        for (const states of [state.commitDetails, state.pullRequests])
            for (const [repoId, state] of states)
                if (!repoIds.has(repoId)) {
                    state.cancellation.cancel();
                    state.cancellation.dispose();
                    states.delete(repoId);
                }
    }

    private loadCommitDetails(state: GitProviderScopeState, repo: GitRepositorySummary): void {
        const sha =
            state.commitSelection?.repositoryId === repo.id ? state.commitSelection.sha : repo.head;
        if (!sha) return;
        const key = `${sha}:${state.refreshSequence}`;
        const current = state.commitDetails.get(repo.id);
        if (current?.key === key) return;
        current?.cancellation.cancel();
        current?.cancellation.dispose();
        const cancellation = new CancellationTokenSource();
        const detail: DetailState<GitCommitDetails> = {
            cancellation,
            // The commit is its own identity: re-reading the same sha may keep showing the settled diff.
            identity: sha,
            key,
            status: 'loading',
            value: current?.identity === sha ? current.value : undefined,
        };
        state.commitDetails.set(repo.id, detail);
        this.detailQueue.enqueue({
            cancellation,
            run: async () => {
                try {
                    const value = await this.workspace.git.commitDetails(
                        { repositoryId: repo.id, sha },
                        cancellation.token,
                    );
                    this.setDetailResult(state, state.commitDetails, repo.id, detail, value);
                } catch {
                    this.setDetailError(state, state.commitDetails, repo.id, detail);
                }
            },
        });
    }

    private loadPullRequest(state: GitProviderScopeState, repo: GitRepositorySummary): void {
        const identity = JSON.stringify([repo.rootPath, repo.branch, repo.head]);
        const key = `${identity}:${state.refreshSequence}`;
        const current = state.pullRequests.get(repo.id);
        if (current?.key === key) return;
        current?.cancellation.cancel();
        current?.cancellation.dispose();
        const cancellation = new CancellationTokenSource();
        const detail: DetailState<GitPullRequestChanges | null> = {
            cancellation,
            identity,
            key,
            status: 'loading',
            value: current?.identity === identity ? current.value : undefined,
        };
        state.pullRequests.set(repo.id, detail);
        /**
         * Only a user action forces the Server (#584). `git.pullRequestChanges` has no last-seen-nonce memory: any
         * nonzero `refresh` bypasses its cache and single-flight key, so the nonce is sent once per action and
         * watcher-driven re-reads send `0`. Marked before the call so a cancelled request does not re-force.
         */
        const isForced = (state.pullRequestForcedSequences.get(repo.id) ?? 0) < state.forceSequence;
        state.pullRequestForcedSequences.set(repo.id, state.forceSequence);
        const refresh = isForced ? state.forceSequence : 0;
        this.detailQueue.enqueue({
            cancellation,
            run: async () => {
                try {
                    const value = await this.workspace.git.pullRequestChanges(
                        repo.id,
                        refresh,
                        cancellation.token,
                    );
                    this.setDetailResult(state, state.pullRequests, repo.id, detail, value);
                } catch (error) {
                    if (
                        error instanceof Error &&
                        error.message === GitPullRequestErrorMessage.missingCommits
                    )
                        detail.errorMessage = GitPullRequestErrorMessage.missingCommits;
                    this.setDetailError(state, state.pullRequests, repo.id, detail);
                }
            },
        });
    }

    private setDetailResult<Value>(
        scope: GitProviderScopeState,
        states: Map<string, DetailState<Value>>,
        repoId: string,
        state: DetailState<Value>,
        value: Value,
    ): void {
        if (this.disposed || state.cancellation.token.isCancellationRequested) return;
        if (states.get(repoId) !== state) return;
        state.status = 'ready';
        state.value = value;
        state.cancellation.dispose();
        this.scheduleContentChange(scope);
    }

    private setDetailError<Value>(
        scope: GitProviderScopeState,
        states: Map<string, DetailState<Value>>,
        repoId: string,
        state: DetailState<Value>,
    ): void {
        if (this.disposed || state.cancellation.token.isCancellationRequested) return;
        if (states.get(repoId) !== state) return;
        state.status = 'error';
        state.cancellation.dispose();
        this.scheduleContentChange(scope);
    }

    private assertRevision(state: GitProviderScopeState, revision: string): void {
        if (revision !== state.revision)
            throw caxri.supersededError('Source Control model revision expired');
    }

    private statesFor(scopeId?: string): GitProviderScopeState[] {
        if (!scopeId) return this.scopes.values().toArray();
        const state = this.scopes.get(scopeId);
        return state ? [state] : [];
    }

    /**
     * The Server compares the nonce against the last one it saw for the Session, and that memory outlives this
     * Extension Host process. Anchoring the nonce to wall-clock time keeps a user refresh forcing after a Host restart
     * reset local state to zero; the `+ 1` floor keeps two actions in the same millisecond distinct.
     */
    private requestForcedRefresh(state: GitProviderScopeState): void {
        state.forceSequence = Math.max(state.forceSequence + 1, Date.now());
    }

    /**
     * Panel actions (`runAction`) and Renderer commands (`executeCommand`) funnel through here so a command that
     * reports `refresh: true` advances the Server-facing nonce exactly once. The command palette's `caxri.git.refresh`
     * is the one exception: its dispatch has no result channel and `executeCommand` resolves scope by repository
     * argument rather than the active context, so `extension.ts` binds it to `forceRefresh`, which advances the same
     * nonce through `requestForcedRefresh`.
     */
    private async executeAction(
        state: GitProviderScopeState,
        command: ActionRegistration['command'],
        token: CancellationToken,
    ): Promise<Omit<SourceControlActionResult, 'revision'>> {
        const result = await this.dispatchCommand(state, command, token);
        if (result.refresh && command.id !== 'caxri.git.toggleExcludedFiles')
            this.requestForcedRefresh(state);
        return result;
    }

    private async dispatchCommand(
        state: GitProviderScopeState,
        command: ActionRegistration['command'],
        token: CancellationToken,
    ): Promise<Omit<SourceControlActionResult, 'revision'>> {
        const arguments_ = command.arguments ?? [];
        switch (command.id) {
            case 'caxri.git.toggleExcludedFiles':
                state.isShowingExcluded = !state.isShowingExcluded;
                return { effects: [], refresh: true };
            case 'caxri.git.refresh':
                return { effects: [], refresh: true };
            case 'caxri.git.openChanges': {
                const resource = arguments_[0];
                if (typeof resource !== 'string')
                    throw providerError('PROVIDER_FAILED', 'Open Changes target is unavailable');
                return { effects: [{ kind: 'open-editor', resource }], refresh: false };
            }
            case 'caxri.git.sync': {
                const [repoId, ahead, behind] = arguments_;
                if (
                    typeof repoId !== 'string' ||
                    typeof ahead !== 'number' ||
                    typeof behind !== 'number' ||
                    !state.repositories.has(repoId)
                )
                    throw providerError('PROVIDER_FAILED', 'Sync target is unavailable');
                await this.workspace.git.sync(repoId, token);
                return {
                    effects: [
                        {
                            kind: 'toast',
                            message:
                                ahead === 0 && behind === 0
                                    ? 'Already up to date'
                                    : 'Synced with remote',
                            tone: 'success',
                        },
                    ],
                    refresh: true,
                };
            }
            case 'caxri.git.discardAll': {
                const [repoId, isBlockedByExclusions = false] = arguments_;
                if (
                    typeof repoId !== 'string' ||
                    typeof isBlockedByExclusions !== 'boolean' ||
                    isBlockedByExclusions ||
                    !state.repositories.has(repoId)
                )
                    throw providerError('PROVIDER_FAILED', 'Discard target is unavailable');
                const result = await this.workspace.git.discard(repoId, { kind: 'all' }, token);
                return { effects: [], refresh: result?.canceled !== true };
            }
            case 'caxri.git.discard': {
                const [repoId, path] = arguments_;
                if (
                    typeof repoId !== 'string' ||
                    typeof path !== 'string' ||
                    !state.repositories.has(repoId)
                )
                    throw providerError('PROVIDER_FAILED', 'Discard target is unavailable');
                const result = await this.workspace.git.discard(
                    repoId,
                    { kind: 'file', path },
                    token,
                );
                return { effects: [], refresh: result?.canceled !== true };
            }
            default:
                throw providerError(
                    'CAPABILITY_DENIED',
                    `Unsupported Source Control action: ${command.id}`,
                );
        }
    }

    async provideView(
        request: {
            activeResource?: string;
            scopeId: string;
            preferredModeId?: string;
            refresh: number;
            revision?: string;
        },
        token: CancellationToken,
    ): Promise<SourceControlViewModel> {
        assertNotCancelled(token);
        const state = this.stateFor(request.scopeId);
        if (!state.hasProvidedView && isMode(request.preferredModeId)) state.isModeChosen = true;
        if (
            isMode(request.preferredModeId) &&
            request.preferredModeId !== state.mode &&
            (!state.commitSelection || request.preferredModeId === 'commit')
        ) {
            if (state.hasProvidedView) state.isModeChosen = true;
            state.mode = request.preferredModeId;
            this.clearDetails(state, true);
        }
        if (request.refresh > state.refreshSequence) {
            state.refreshSequence = request.refresh;
            this.clearDetails(state, true);
        }
        const revision = this.nextRevision(state);
        const rawSummary = await this.workspace.git.summary(state.forceSequence, token);
        assertNotCancelled(token);
        if (revision !== state.revision)
            throw caxri.supersededError('Source Control snapshot was superseded');
        const diffExclude =
            await this.workspace.getConfiguration<Readonly<Record<string, boolean>>>(
                'git.diffExclude',
            );
        assertNotCancelled(token);
        if (revision !== state.revision)
            throw caxri.supersededError('Source Control snapshot was superseded');
        state.diffExclude = diffExclude ?? {};

        if (
            state.commitSelection &&
            rawSummary.repositories.every(({ id }) => id !== state.commitSelection?.repositoryId)
        ) {
            state.commitSelection = undefined;
            this.clearDetails(state);
        }
        const summary = state.commitSelection
            ? {
                  ...rawSummary,
                  repositories: rawSummary.repositories.filter(
                      ({ id }) => id === state.commitSelection?.repositoryId,
                  ),
              }
            : rawSummary;
        const details = new Map<string, GitCommitDetails>();
        const pullRequests = new Map<string, GitPullRequestChanges | null>();
        const detailErrors = new Map<string, true | string>();
        const repoIds = new Set(summary.repositories.map(({ id }) => id));
        this.pruneDetails(state, repoIds);
        const load = (repo: GitRepositorySummary) => this.loadPullRequest(state, repo);
        if (shouldAutoSelectPullRequestMode(state, summary.repositories, load))
            state.mode = 'pull-request';
        for (const repo of summary.repositories) {
            if (state.mode === 'commit') {
                this.loadCommitDetails(state, repo);
                const detail = state.commitDetails.get(repo.id);
                if (detail?.status === 'error') detailErrors.set(repo.id, true);
                else if (detail?.value) details.set(repo.id, detail.value);
            } else if (state.mode === 'pull-request' && canDetectPullRequest(repo)) {
                this.loadPullRequest(state, repo);
                const detail = state.pullRequests.get(repo.id);
                if (detail?.status === 'error')
                    detailErrors.set(repo.id, detail.errorMessage ?? true);
                else if (detail?.value !== undefined) pullRequests.set(repo.id, detail.value);
            }
        }
        /**
         * Commit mode may narrow visible providers to one repository, while File History still targets the deepest
         * repository containing the active file. Preserve every approved raw scope for history authorization.
         */
        for (const repo of rawSummary.repositories) state.repositories.set(repo.id, repo);
        state.hasProvidedView = true;
        return boundSourceControlViewModel(
            buildSourceControlViewModel({
                activeResource: request.activeResource,
                mode: state.mode,
                summary,
                revision,
                detailsByRepository: details,
                detailErrorsByRepository: detailErrors,
                excludePatterns: state.diffExclude,
                selectedCommitSha: state.commitSelection?.sha,
                pullRequestsByRepository: pullRequests,
                fileHistoryRepositories: rawSummary.repositories,
                registerAction: this.registerActionFor(state),
                isShowingExcluded: state.isShowingExcluded,
            }),
        );
    }

    async provideHistoryPage(
        request: {
            historyId: string;
            itemActivation?: 'action';
            scopeId: string;
            offset: number;
            pageSize: number;
            path?: string;
            revision: string;
        },
        token: CancellationToken,
    ): Promise<SourceControlHistoryPage> {
        const state = this.stateFor(request.scopeId);
        this.assertRevision(state, request.revision);
        assertNotCancelled(token);
        if (!state.repositories.has(request.historyId))
            throw providerError(
                'PROJECT_SCOPE_DENIED',
                'Source Control history target is unavailable',
            );
        const pageRequest = this.workspace.git.commits(
            {
                repositoryId: request.historyId,
                offset: request.offset,
                pageSize: request.pageSize,
                ...(request.path && { path: request.path }),
            },
            token,
        );
        const remoteHostRequest = (async (): Promise<string | null | undefined> => {
            let remoteHost = state.avatarHosts.get(request.historyId);
            if (state.avatarHosts.has(request.historyId)) return remoteHost;
            const fetchAvatars =
                (await this.workspace.getConfiguration<boolean>('git.fetchGitHubAvatars')) ?? false;
            assertNotCancelled(token);
            this.assertRevision(state, request.revision);
            if (fetchAvatars)
                try {
                    remoteHost = await this.workspace.git.remoteHost(request.historyId, token);
                } catch {
                    assertNotCancelled(token);
                    remoteHost = null;
                }
            else remoteHost = null;
            assertNotCancelled(token);
            this.assertRevision(state, request.revision);
            state.avatarHosts.set(request.historyId, remoteHost);
            return remoteHost;
        })();
        const [page, remoteHost] = await Promise.all([pageRequest, remoteHostRequest]);
        assertNotCancelled(token);
        this.assertRevision(state, request.revision);
        return buildSourceControlHistoryPage(
            page,
            request.revision,
            remoteHost,
            request.itemActivation === 'action' && request.path
                ? {
                      path: request.path,
                      registerAction: this.registerActionFor(state),
                      repositoryId: request.historyId,
                  }
                : undefined,
        );
    }

    async provideHistoryDetails(
        request: {
            historyId: string;
            itemId: string;
            scopeId: string;
            path?: string;
            revision: string;
        },
        token: CancellationToken,
    ): Promise<SourceControlHistoryDetails> {
        const state = this.stateFor(request.scopeId);
        this.assertRevision(state, request.revision);
        assertNotCancelled(token);
        if (!state.repositories.has(request.historyId))
            throw providerError(
                'PROJECT_SCOPE_DENIED',
                'Source Control history target is unavailable',
            );
        const details = await this.workspace.git.commitDetails(
            {
                repositoryId: request.historyId,
                sha: request.itemId,
                ...(request.path && { path: request.path }),
            },
            token,
        );
        assertNotCancelled(token);
        this.assertRevision(state, request.revision);
        return buildSourceControlHistoryDetails({
            details,
            excludePatterns: state.diffExclude,
            registerAction: this.registerActionFor(state),
            repositoryId: request.historyId,
            revision: request.revision,
            isShowingExcluded: state.isShowingExcluded,
        });
    }

    async runAction(
        request: { actionId: string; scopeId: string; revision: string },
        token: CancellationToken,
    ): Promise<SourceControlActionResult> {
        const state = this.stateFor(request.scopeId);
        this.assertRevision(state, request.revision);
        assertNotCancelled(token);
        const registration = state.actions.get(request.actionId);
        if (!registration || registration.revision !== request.revision)
            throw caxri.supersededError('Source Control action expired');
        const result = await this.executeAction(state, registration.command, token);
        /**
         * Git invalidation commonly advances the model while an authorized Sync or Discard is completing. Its
         * authoritative result must not become a retryable error after the mutation boundary has already been crossed.
         */
        return { revision: request.revision, ...result };
    }

    executeCommand(
        commandId: string,
        arguments_: readonly unknown[],
        token: CancellationToken,
    ): Promise<Omit<SourceControlActionResult, 'revision'>> {
        const repoId = arguments_[0];
        const state =
            typeof repoId === 'string'
                ? (this.scopes.values().find((candidate) => candidate.repositories.has(repoId)) ??
                  this.scopes.values().next().value)
                : this.scopes.values().next().value;
        if (
            commandId === 'caxri.git.history' &&
            typeof repoId === 'string' &&
            state?.repositories.has(repoId)
        )
            return Promise.resolve({ effects: [], refresh: false });
        if (!state) throw providerError('PROJECT_SCOPE_DENIED', 'Git command scope is unavailable');
        return this.executeAction(state, { id: commandId, arguments: arguments_ }, token);
    }

    async openCommit(
        scopeId: string,
        repoId: string,
        sha: string,
        token: CancellationToken,
    ): Promise<void> {
        if (!/^[0-9a-f]{40}$/.test(sha))
            throw providerError('PROVIDER_FAILED', 'Git commit reference is invalid');
        const state = this.stateFor(scopeId);
        const openSequence = ++state.commitOpenSequence;
        const summary = await this.workspace.git.summary(0, token);
        assertNotCancelled(token);
        if (this.disposed || openSequence !== state.commitOpenSequence) return;
        if (summary.repositories.every(({ id }) => id !== repoId))
            throw providerError(
                'PROJECT_SCOPE_DENIED',
                'Git commit does not belong to the active Session',
            );
        this.clearDetails(state, true);
        state.commitSelection = { repositoryId: repoId, sha };
        state.isModeChosen = true;
        state.mode = 'commit';
        this.changed.fire({ kind: 'selection', selectedModeId: 'commit' });
    }

    /**
     * Renderer navigation can start the new snapshot before its matching extension command arrives. A repeated
     * same-mode command must preserve those in-flight details; clearing them would leave the already-rendered loading
     * model without another query to replace it. Selecting Last Commit still clears an arbitrary commit selection.
     */
    setMode(mode: GitSourceControlMode, scopeId?: string): void {
        const state = scopeId ? this.scopes.get(scopeId) : undefined;
        if (state) {
            state.commitOpenSequence += 1;
            state.isModeChosen = true;
            if (state.mode !== mode || state.commitSelection) {
                this.clearDetails(state, true);
                state.commitSelection = undefined;
                state.mode = mode;
                this.scheduleContentChange(state);
            }
        }
        this.changed.fire({ kind: 'selection', selectedModeId: mode });
    }

    /**
     * Watcher-driven or context-driven re-read: invalidates details and asks the Renderer to re-read the view, but
     * keeps the Server-facing nonce so the Server joins its current generation instead of forcing a re-discovery.
     */
    refresh(scopeId?: string): void {
        for (const state of this.statesFor(scopeId)) {
            this.clearDetails(state, true);
            this.nextRevision(state);
        }
        this.changed.fire({ kind: 'refresh' });
    }

    /**
     * User-initiated refresh outside the panel (command palette): forces the Server like the panel's Refresh action.
     */
    forceRefresh(scopeId?: string): void {
        for (const state of this.statesFor(scopeId)) this.requestForcedRefresh(state);
        this.refresh(scopeId);
    }

    dispose(): void {
        this.disposed = true;
        for (const state of this.scopes.values()) {
            this.clearDetails(state);
            state.actions.clear();
            state.avatarHosts.clear();
            state.repositories.clear();
        }
        this.scopes.clear();
        this.detailQueue.dispose();
        this.changed.dispose();
    }
}

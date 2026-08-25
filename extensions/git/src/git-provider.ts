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
import caxri, { CancellationTokenSource, EventEmitter } from 'caxri';

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
    cancellation: CancellationTokenSource;
    key: string;
    status: 'error' | 'loading' | 'ready';
    value?: Value;
}

interface GitProviderScopeState {
    actions: Map<string, RegisteredAction>;
    avatarHosts: Map<string, string | null>;
    commitDetails: Map<string, DetailState<GitCommitDetails>>;
    contentTimer?: ReturnType<typeof setTimeout>;
    mode: GitSourceControlMode;
    pullRequests: Map<string, DetailState<GitPullRequestChanges | null>>;
    repositories: Map<string, GitRepositorySummary>;
    actionSequence: number;
    revision: string;
    revisionSequence: number;
    refreshSequence: number;
}

interface DetailTask {
    cancellation: CancellationTokenSource;
    run: () => Promise<void>;
}

const MAX_CONCURRENT_DETAIL_REQUESTS = 4;
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
    private activeDetailRequests = 0;
    private readonly detailSlotWaiters: Array<() => void> = [];
    private readonly detailTasks = new Set<DetailTask>();
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
            mode: 'working',
            pullRequests: new Map(),
            repositories: new Map(),
            actionSequence: 0,
            refreshSequence: 0,
            revision: '0',
            revisionSequence: 0,
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

    private clearDetails(state: GitProviderScopeState): void {
        if (state.contentTimer) clearTimeout(state.contentTimer);
        state.contentTimer = undefined;
        for (const detail of [...state.commitDetails.values(), ...state.pullRequests.values()]) {
            detail.cancellation.cancel();
            detail.cancellation.dispose();
        }
        state.commitDetails.clear();
        state.pullRequests.clear();
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

    private async acquireDetailSlot(): Promise<void> {
        if (this.activeDetailRequests < MAX_CONCURRENT_DETAIL_REQUESTS) {
            this.activeDetailRequests += 1;
            return;
        }
        await new Promise<void>((resolve) => this.detailSlotWaiters.push(resolve));
    }

    private releaseDetailSlot(): void {
        const next = this.detailSlotWaiters.shift();
        if (next) next();
        else this.activeDetailRequests -= 1;
    }

    private enqueueDetail(task: DetailTask): void {
        this.detailTasks.add(task);
        /**
         * Start the async wrapper in the originating provider call's AsyncLocalStorage context. Deferring `task.run`
         * from a previous scope's completion callback would bind its authorized workspace requests to that scope.
         */
        // eslint-disable-next-line no-void -- the bounded queue owns completion and cancellation
        void (async () => {
            await this.acquireDetailSlot();
            try {
                if (!task.cancellation.token.isCancellationRequested) await task.run();
            } finally {
                this.detailTasks.delete(task);
                this.releaseDetailSlot();
            }
        })();
    }

    private loadCommitDetails(state: GitProviderScopeState, repo: GitRepositorySummary): void {
        if (!repo.head) return;
        const key = `${repo.head}:${state.refreshSequence}`;
        const current = state.commitDetails.get(repo.id);
        if (current?.key === key) return;
        current?.cancellation.cancel();
        current?.cancellation.dispose();
        const cancellation = new CancellationTokenSource();
        const detail: DetailState<GitCommitDetails> = { cancellation, key, status: 'loading' };
        state.commitDetails.set(repo.id, detail);
        this.enqueueDetail({
            cancellation,
            run: async () => {
                try {
                    const value = await this.workspace.git.commitDetails(
                        { repositoryId: repo.id, sha: repo.head! },
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
        const key = `${repo.head ?? ''}:${state.refreshSequence}`;
        const current = state.pullRequests.get(repo.id);
        if (current?.key === key) return;
        current?.cancellation.cancel();
        current?.cancellation.dispose();
        const cancellation = new CancellationTokenSource();
        const detail: DetailState<GitPullRequestChanges | null> = {
            cancellation,
            key,
            status: 'loading',
        };
        state.pullRequests.set(repo.id, detail);
        this.enqueueDetail({
            cancellation,
            run: async () => {
                try {
                    const value = await this.workspace.git.pullRequestChanges(
                        repo.id,
                        state.refreshSequence,
                        cancellation.token,
                    );
                    this.setDetailResult(state, state.pullRequests, repo.id, detail, value);
                } catch {
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
            throw providerError('GENERATION_EXPIRED', 'Source Control model revision expired');
    }

    private async executeAction(
        state: GitProviderScopeState,
        command: ActionRegistration['command'],
        token: CancellationToken,
    ): Promise<Omit<SourceControlActionResult, 'revision'>> {
        const arguments_ = command.arguments ?? [];
        switch (command.id) {
            case 'caxri.git.refresh':
                return { effects: [], refresh: true };
            case 'caxri.git.openChanges': {
                const resource = arguments_[0];
                if (typeof resource !== 'string')
                    throw providerError('PROVIDER_FAILED', 'Open Changes target is unavailable');
                return { effects: [{ kind: 'open-editor', resource }], refresh: false };
            }
            case 'caxri.git.openSubmodule': {
                const targetId = arguments_[0];
                if (typeof targetId !== 'string')
                    throw providerError('PROVIDER_FAILED', 'Submodule target is unavailable');
                return { effects: [{ kind: 'focus', targetId }], refresh: false };
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
                const [repoId] = arguments_;
                if (typeof repoId !== 'string' || !state.repositories.has(repoId))
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
            scopeId: string;
            preferredModeId?: string;
            refresh: number;
            revision?: string;
        },
        token: CancellationToken,
    ): Promise<SourceControlViewModel> {
        assertNotCancelled(token);
        const state = this.stateFor(request.scopeId);
        if (isMode(request.preferredModeId) && request.preferredModeId !== state.mode) {
            state.mode = request.preferredModeId;
            this.clearDetails(state);
        }
        if (request.refresh > state.refreshSequence) {
            state.refreshSequence = request.refresh;
            this.clearDetails(state);
        }
        const revision = this.nextRevision(state);
        const summary = await this.workspace.git.summary(state.refreshSequence, token);
        assertNotCancelled(token);
        if (revision !== state.revision)
            throw providerError('GENERATION_EXPIRED', 'Source Control snapshot was superseded');

        const details = new Map<string, GitCommitDetails>();
        const pullRequests = new Map<string, GitPullRequestChanges | null>();
        const detailErrors = new Map<string, true>();
        const repoIds = new Set(summary.repositories.map(({ id }) => id));
        this.pruneDetails(state, repoIds);
        for (const repo of summary.repositories) {
            if (state.mode === 'commit') {
                this.loadCommitDetails(state, repo);
                const detail = state.commitDetails.get(repo.id);
                if (detail?.status === 'ready' && detail.value) details.set(repo.id, detail.value);
                else if (detail?.status === 'error') detailErrors.set(repo.id, true);
            } else if (state.mode === 'pull-request') {
                this.loadPullRequest(state, repo);
                const detail = state.pullRequests.get(repo.id);
                if (detail?.status === 'ready') pullRequests.set(repo.id, detail.value ?? null);
                else if (detail?.status === 'error') detailErrors.set(repo.id, true);
            }
        }
        for (const repo of summary.repositories) state.repositories.set(repo.id, repo);
        return boundSourceControlViewModel(
            buildSourceControlViewModel({
                mode: state.mode,
                summary,
                revision,
                detailsByRepository: details,
                detailErrorsByRepository: detailErrors,
                pullRequestsByRepository: pullRequests,
                registerAction: this.registerActionFor(state),
            }),
        );
    }

    async provideHistoryPage(
        request: {
            historyId: string;
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
        return buildSourceControlHistoryPage(page, request.revision, remoteHost);
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
            registerAction: this.registerActionFor(state),
            repositoryId: request.historyId,
            revision: request.revision,
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
            throw providerError('GENERATION_EXPIRED', 'Source Control action expired');
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

    setMode(mode: GitSourceControlMode): void {
        this.changed.fire({ kind: 'selection', selectedModeId: mode });
    }

    refresh(scopeId?: string): void {
        const scopedState = scopeId ? this.scopes.get(scopeId) : undefined;
        const states: Iterable<GitProviderScopeState> = scopeId
            ? scopedState
                ? [scopedState]
                : []
            : this.scopes.values();
        for (const state of states) {
            this.clearDetails(state);
            this.nextRevision(state);
        }
        this.changed.fire({ kind: 'refresh' });
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
        for (const task of this.detailTasks) {
            task.cancellation.cancel();
            task.cancellation.dispose();
        }
        this.detailTasks.clear();
        this.changed.dispose();
    }
}

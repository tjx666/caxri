import type { SourceControlProvider } from './view-providers.js';
import type { WorkspaceGit } from './workspace.js';

export type {
    ControlledViewProviderResult,
    SourceControlAction,
    SourceControlActionEffect,
    SourceControlActionResult,
    SourceControlChange,
    SourceControlCommandBinding,
    SourceControlExternalLink,
    SourceControlFileHistory,
    SourceControlGroup,
    SourceControlHistoryDescriptor,
    SourceControlHistoryDetails,
    SourceControlHistoryItem,
    SourceControlHistoryPage,
    SourceControlMode,
    SourceControlProvider,
    SourceControlProviderModel,
    SourceControlResource,
    SourceControlResourceDecoration,
    SourceControlViewIcon,
    SourceControlViewModel,
} from './view-providers.js';
export type {
    GitCommit,
    GitCommitDetails,
    GitCommitFile,
    GitCommitPage,
    GitFileStatus,
    GitPullRequestChanges,
    GitRepositorySummary,
    GitSummary,
    WorkspaceGit,
} from './workspace.js';
export type GlobPatternSettings = Readonly<Record<string, boolean>>;

/**
 * Matches a root-relative path using the Extension Host's shared glob semantics.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- The published stub preserves the signature replaced by the Extension Host.
export function isGlobMatch(_relativePath: string, _patterns: GlobPatternSettings): boolean {
    return unavailable('isGlobMatch');
}

export interface DisposableLike {
    dispose(): void;
}

export class Disposable implements DisposableLike {
    static from(...disposables: readonly DisposableLike[]): Disposable {
        return new Disposable(() => {
            for (const disposable of disposables) disposable.dispose();
        });
    }

    private isDisposed = false;

    constructor(private readonly callOnDispose: () => void = () => {}) {}

    dispose(): void {
        if (this.isDisposed) return;
        this.isDisposed = true;
        this.callOnDispose();
    }
}

export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: Event<void>;
}

export type Event<T> = (listener: (event: T) => unknown) => Disposable;

export class EventEmitter<T> implements DisposableLike {
    private readonly listeners = new Set<(event: T) => unknown>();
    private isDisposed = false;

    readonly event: Event<T> = (listener) => {
        if (this.isDisposed) return new Disposable();
        this.listeners.add(listener);
        return new Disposable(() => this.listeners.delete(listener));
    };

    fire(event: T): void {
        if (this.isDisposed) return;
        for (const listener of this.listeners) listener(event);
    }

    dispose(): void {
        this.isDisposed = true;
        this.listeners.clear();
    }
}

export class CancellationTokenSource implements DisposableLike {
    // eslint-disable-next-line unicorn/prefer-event-target -- The public API intentionally mirrors VS Code's EventEmitter contract.
    private readonly cancellation = new EventEmitter<void>();
    private isCancelled = false;
    readonly token: CancellationToken;

    constructor() {
        // eslint-disable-next-line unicorn/no-this-assignment, @typescript-eslint/no-this-alias -- The token getter must retain the source identity while exposing a stable public token object.
        const source = this;
        this.token = {
            get isCancellationRequested() {
                return source.isCancelled;
            },
            onCancellationRequested: this.cancellation.event,
        };
    }

    cancel(): void {
        if (this.isCancelled) return;
        this.isCancelled = true;
        this.cancellation.fire();
    }

    dispose(): void {
        this.cancel();
        this.cancellation.dispose();
    }
}

export class ThemeIcon {
    constructor(
        /**
         * Workbench-owned glyph id. The Workbench, not the extension, decides what it looks like.
         */
        readonly id: string,
        /**
         * Optional `#RRGGBB` tint, for an icon standing in for content whose palette an external system owns — a Linear
         * workflow state's configured color. Leave it unset for anything Caxri itself defines: those icons must follow
         * the active theme, and the Extension Host rejects any other color literal at the boundary.
         */
        readonly color?: string,
    ) {}
}

export const TreeItemCollapsibleState = {
    None: 0,
    Collapsed: 1,
    Expanded: 2,
} as const;

// eslint-disable-next-line @typescript-eslint/no-redeclare -- Preserve the VS Code-compatible const/type public API pair.
export type TreeItemCollapsibleState =
    (typeof TreeItemCollapsibleState)[keyof typeof TreeItemCollapsibleState];

export type TreeItemVariant = 'header' | 'message';

export interface Command {
    command: string;
    title: string;
    arguments?: readonly unknown[];
}

export type TreeItemTooltipTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface TreeItemTooltipRow {
    label: string;
    value: string;
    /**
     * HTTP(S) destination opened through Caxri's trusted-origin policy.
     */
    url?: string;
}

/**
 * Bounded interactive content for a TreeItem hover card. Text is rendered literally (`markdown` through a closed,
 * HTML-free subset) and URLs are validated by the Extension Host before reaching the Renderer, so extensions cannot
 * inject HTML, scripts, or command links.
 */
export interface TreeItemRichTooltip {
    kind: 'rich';
    title: string;
    /**
     * Prose that explains the title, such as a provider error's recovery hint. Structured facts belong in `rows`.
     */
    description?: string;
    /**
     * Markdown body for authored prose such as a pull request review comment; takes the place of `description`. The
     * Renderer shows a closed subset (paragraphs, lists, quotes, code, emphasis, HTTP(S) links) as text nodes. Raw HTML
     * is dropped and images collapse to their alt text, so this does not widen what an extension can inject.
     */
    markdown?: string;
    badge?: { label: string; tone: TreeItemTooltipTone };
    /**
     * Omitted or empty when the title and badge already carry the whole hover, so a row without structured facts keeps
     * the same card instead of falling back to a plain-text tooltip.
     */
    rows?: readonly TreeItemTooltipRow[];
}

export class TreeItem {
    id?: string;
    /**
     * Optional semantic presentation. A header introduces a visually separated group of child rows. A message is a leaf
     * that presents complete guidance and an optional action instead of compressing them into a normal data row. Both
     * keep the shared tree Renderer independent of extension-specific domains such as repositories.
     */
    variant?: TreeItemVariant;
    description?: string;
    tooltip?: string | TreeItemRichTooltip;
    iconPath?: ThemeIcon;
    /**
     * Optional trailing metadata icon; describe its meaning in the tooltip and accessible label.
     */
    trailingIcon?: ThemeIcon;
    command?: Command;
    accessibilityInformation?: { label: string };

    constructor(
        readonly label: string,
        readonly collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None,
    ) {}
}

export type ProviderResult<T> = T | undefined | null | Promise<T | undefined | null>;

export interface TreeDataProvider<T> {
    readonly onDidChangeTreeData?: Event<T | readonly T[] | undefined>;
    getChildren(element: T | undefined, token: CancellationToken): ProviderResult<readonly T[]>;
    getTreeItem(element: T): ProviderResult<TreeItem>;
}

/**
 * Activity owned by a view; the Workbench formats and aggregates it on the container.
 *
 * Report meaning, not appearance — the Workbench picks the icon and the fill, so a container never shows two views'
 * badges in two unrelated colors. `count` is a plain tally. `error` and `warning` are severities: the Workbench draws
 * its own fixed glyph for them, so they stay legible without relying on color.
 *
 * A severity deliberately has no `count` field. A glyph and a digit cannot share one chip, so a counted severity would
 * fall back to a digit and leave the fill as the only thing separating "5 changes" from "5 failures" — nothing to a
 * colorblind user or in a greyscale capture. Say how many in `description`; the Workbench publishes it in the container
 * tab's tooltip and accessible description whether or not the tally reaches the chip.
 */
export type ViewBadge =
    | { kind: 'count'; count: number; description: string }
    | { kind: 'error' | 'warning'; description: string };

export interface ViewBadgeProvider {
    /**
     * Fires within a scoped Workspace notification or provider callback; unscoped events are ignored.
     */
    readonly onDidChangeBadge?: Event<void>;
    /**
     * Runs in the requested Workbench scope, including before the view has ever been opened.
     */
    provideBadge(request: { scopeId: string }, token: CancellationToken): ProviderResult<ViewBadge>;
}

export interface ExtensionContext {
    readonly extensionId: string;
    readonly generation: number;
    readonly subscriptions: DisposableLike[];
}

export type ProjectStatusState =
    | 'success'
    | 'failure'
    | 'cancelled'
    /**
     * Executing right now.
     */
    | 'pending'
    /**
     * Accepted but not started — waiting for a runner.
     */
    | 'queued'
    | 'neutral'
    | 'unknown';

export interface ProjectStatusCheck {
    name: string;
    state: ProjectStatusState;
    url?: string;
    durationMs?: number;
    /**
     * When the check settled, in epoch milliseconds.
     */
    completedAt?: number;
}

export interface ProjectStatusReviewThread {
    /**
     * Opens the thread's first comment on GitHub.
     */
    url: string;
    body: string;
    author?: string;
    /**
     * Epoch milliseconds of the opening comment.
     */
    createdAt?: number;
    path?: string;
    line?: number;
}

export interface ProjectStatusLinearIssue {
    identifier: string;
    title?: string;
    url?: string;
    state?: string;
    stateType?:
        'backlog' | 'canceled' | 'completed' | 'duplicate' | 'started' | 'triage' | 'unstarted';
    /**
     * `#RRGGBB` color the Linear workspace configured for this workflow state. `stateType` cannot stand in for it:
     * Linear files "In Progress", "In Review", and "Ready to Merge" all under `started`, and each workspace picks their
     * colors independently, so a state Linear shows green renders as whatever tone the type is quantized to.
     */
    stateColor?: string;
}

/**
 * Where an acceptance report sits in its own lifecycle. Distinct from {@link AcceptanceVerdict}: a report can be
 * `repairing` after a round already returned `failed`, and `accepted` is a person's decision rather than a run's
 * result.
 */
export type AcceptanceStatus =
    | 'pending'
    | 'planned'
    | 'verifying'
    | 'repairing'
    | 'delivered'
    | 'accepted'
    | 'closed'
    | 'rejected'
    | 'errored';

/**
 * What one verification round concluded. `uncertain` is a real third outcome, not a missing value: a round that could
 * not decide is explicitly different from one that has not finished.
 */
export type AcceptanceVerdict = 'passed' | 'failed' | 'uncertain';

/**
 * One acceptance report a branch is delivering against. Everything past `id` and `state` is absent until the report
 * resolves, so a link Caxri recognized but could not read still renders as itself.
 */
export interface ProjectStatusAcceptance {
    id: string;
    /**
     * The report reduced to the same vocabulary a check or a deployment reports, so a view can draw all three from one
     * presentation. Caxri computes it from `status` and `verdict`; a view must not re-derive it.
     */
    state: ProjectStatusState;
    url?: string;
    /**
     * The 1-based round the link pinned, when it named one. Absent means the link addressed the report as a whole, and
     * the latest round is the one that answered for it.
     */
    round?: number;
    title?: string;
    status?: AcceptanceStatus;
    verdict?: AcceptanceVerdict;
    passedChecks?: number;
    totalChecks?: number;
    roundCount?: number;
}

/**
 * The Git commit a provider built. Absent when the deployment came from a direct CLI upload rather than a connected
 * repository, so a view must keep a fallback identity for the deployment.
 */
export interface ProjectStatusDeploymentCommit {
    sha: string;
    /**
     * Subject line only. Providers carry the full message, and a body turns a one-line row into a paragraph.
     */
    message?: string;
    authorLogin?: string;
    url?: string;
}

export interface ProjectStatusDeployment {
    environment: 'production' | 'preview';
    hostname: string;
    state: ProjectStatusState;
    url: string;
    inspectorUrl?: string;
    createdAt?: number;
    commit?: ProjectStatusDeploymentCommit;
}

export interface ProjectStatusError {
    source: 'acceptance' | 'github' | 'linear' | 'vercel';
    kind: 'prerequisite' | 'failure';
    /**
     * Present when the failure describes the whole Project rather than the repository reporting it — a lost connection,
     * or a provider budget the account shares — so a view can state it once instead of per repository.
     */
    reason?: 'network' | 'rate-limited' | 'tls';
    message: string;
    hint: string;
    /**
     * Epoch ms when Caxri queries this provider again, for `rate-limited` failures whose deadline is known. Compare it
     * against the current time: a cached status snapshot outlives its own pause.
     */
    retryAt?: number;
    /**
     * Where in the log viewer this failure left its record, for an error whose real explanation is only in the logs. A
     * view offering "Open Logs" passes this along so the panel opens already filtered to the failing event instead of
     * on every process's records at every level.
     */
    logs?: {
        /**
         * The viewer's text filter, in the grammar the user types: OR on commas, `!` excludes.
         */
        filter: string;
        /**
         * The levels left on — the levels the named event is written at, and no others.
         */
        levels: Array<'debug' | 'info' | 'warn' | 'error'>;
    };
}

// eslint-disable-next-line unicorn/name-replacements -- This name is part of the public project-status API contract.
export interface ProjectStatusRepository {
    id: string;
    kind: 'primary' | 'worktree' | 'nested' | 'submodule';
    name: string;
    branch: string;
    defaultBranch?: string;
    githubUrl?: string;
    branchUrl?: string;
    /**
     * Publication on origin at checkedAt; local tracking refs are never proof of remote existence.
     */
    publication?: {
        state:
            | 'checking'
            | 'unpublished'
            | 'published'
            | 'synced'
            | 'ahead'
            | 'behind'
            | 'diverged'
            | 'unknown'
            | 'no-origin'
            | 'unsupported'
            | 'detached'
            | 'unborn';
        remoteBranch?: string;
        checkedAt?: number;
        ahead?: number;
        behind?: number;
    };
    pullRequest?: {
        number: number;
        title: string;
        url: string;
        state: ProjectStatusState;
        checks: ProjectStatusCheck[];
        hiddenCheckCount: number;
        /**
         * PR lifecycle, independent of the CI rollup; absent if the provider omits it.
         */
        lifecycle?: 'draft' | 'open' | 'merged' | 'closed';
        /**
         * Unresolved, non-outdated review threads; absent when they were not read.
         */
        unresolvedReviewThreads?: ProjectStatusReviewThread[];
    };
    linearIssues: ProjectStatusLinearIssue[];
    acceptances: ProjectStatusAcceptance[];
    deployments?: {
        url: string;
        branchDeployments: ProjectStatusDeployment[];
        production?: ProjectStatusDeployment;
        preview?: ProjectStatusDeployment;
    };
    errors: ProjectStatusError[];
}

export interface ProjectStatusSummary {
    repositories: ProjectStatusRepository[];
    refreshedAt: number;
    error?: string;
}

/**
 * Stable top-level Project Status messages shared with product extensions until the summary contract exposes structured
 * error kinds. Consumers must treat every other error string as an unrelated failure.
 */
export const ProjectStatusSummaryErrorMessage = Object.freeze({
    missingGitRepository: 'The Project root is not a Git repository.',
    missingPrimaryRepository: 'No primary repository found.',
} as const);

/**
 * Safe PR detail failures that product extensions may display across the error boundary.
 */
export const GitPullRequestErrorMessage = Object.freeze({
    missingCommits:
        'Required pull request commits could not be downloaded. Check remote access and refresh.',
} as const);

export interface ProjectStatusRequestOptions {
    /**
     * A unique, bounded token bypasses the settled Runtime cache exactly once.
     */
    refreshToken?: string;
}

/**
 * Opaque Workbench scope attached to Extension Host lifecycle notifications. Product extensions can partition provider
 * state without learning or submitting native paths.
 */
export interface WorkspaceChangeContext {
    scopeId: string;
}

export interface CaxriApi {
    readonly commands: {
        registerCommand(
            commandId: string,
            callback: (...arguments_: readonly unknown[]) => unknown,
        ): Disposable;
    };
    readonly views: {
        registerViewBadgeProvider(viewId: string, provider: ViewBadgeProvider): Disposable;
        registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>): Disposable;
        registerSourceControlProvider(viewId: string, provider: SourceControlProvider): Disposable;
    };
    readonly workspace: {
        readonly onDidChangeActiveContext: Event<WorkspaceChangeContext>;
        readonly onDidChangeGit: Event<WorkspaceChangeContext>;
        readonly onDidChangeProjectStatus: Event<WorkspaceChangeContext>;
        readonly git: WorkspaceGit;
        /**
         * Returns the opaque scope attached to the current provider callback or command. Outside those callbacks there
         * is deliberately no ambient authority and this returns `undefined`.
         */
        getCurrentContext(): WorkspaceChangeContext | undefined;
        getConfiguration<Value = unknown>(key: string): Promise<Value | undefined>;
        getProjectStatus(options?: ProjectStatusRequestOptions): Promise<ProjectStatusSummary>;
    };
    /**
     * Builds the error a provider throws when a request arrived against a model revision it has already replaced.
     *
     * Throw this instead of your own `GENERATION_EXPIRED` whenever the staleness is your extension's own bookkeeping —
     * a snapshot superseded by a newer `provideView`, an action carrying a revision you no longer serve. Caxri cannot
     * see your revision, so an equivalent error you construct yourself is indistinguishable from a real failure and is
     * logged as one, recommending an Extension Host restart.
     *
     * This is a trust contract, not an escape hatch: Caxri records the result at `debug` because you declared it
     * routine. Wrapping a genuine failure in it hides that failure from diagnostics.
     */
    supersededError(message: string): Error;
}

function unavailable(method: string): never {
    const error = Object.assign(
        new Error(
            `The caxri API method ${method} is available only inside the Caxri Extension Host.`,
        ),
        { code: 'CAXRI_API_OUTSIDE_EXTENSION_HOST' },
    );
    Object.defineProperty(error, 'name', {
        configurable: true,
        enumerable: true,
        value: 'CaxriApiUnavailableError',
        writable: true,
    });
    throw error;
}

const outsideHostEvent =
    <T>(): Event<T> =>
    () =>
        new Disposable();

const caxri: CaxriApi = Object.freeze({
    commands: Object.freeze({
        registerCommand: () => unavailable('commands.registerCommand'),
    }),
    views: Object.freeze({
        registerViewBadgeProvider: () => unavailable('views.registerViewBadgeProvider'),
        registerSourceControlProvider: () => unavailable('views.registerSourceControlProvider'),
        registerTreeDataProvider: () => unavailable('views.registerTreeDataProvider'),
    }),
    workspace: Object.freeze({
        onDidChangeActiveContext: outsideHostEvent<WorkspaceChangeContext>(),
        onDidChangeGit: outsideHostEvent<WorkspaceChangeContext>(),
        onDidChangeProjectStatus: outsideHostEvent<WorkspaceChangeContext>(),
        git: Object.freeze({
            commits: () => unavailable('workspace.git.commits'),
            commitDetails: () => unavailable('workspace.git.commitDetails'),
            discard: () => unavailable('workspace.git.discard'),
            pullRequestChanges: () => unavailable('workspace.git.pullRequestChanges'),
            remoteHost: () => unavailable('workspace.git.remoteHost'),
            summary: () => unavailable('workspace.git.summary'),
            sync: () => unavailable('workspace.git.sync'),
        }),
        getCurrentContext: () => unavailable('workspace.getCurrentContext'),
        getConfiguration: () => unavailable('workspace.getConfiguration'),
        getProjectStatus: () => unavailable('workspace.getProjectStatus'),
    }),
    /**
     * Unlike every other member here this does not call {@link unavailable}: it mints a value rather than reaching into
     * the Host, so a provider under unit test can still throw it and assert the code. The object simply is not
     * registered as a declared non-fault — outside the Extension Host there is no classifier to declare it to, and an
     * unregistered error is classified exactly as it was before this contract existed.
     */
    supersededError: (message: string) =>
        Object.assign(new Error(message), { code: 'GENERATION_EXPIRED' }),
});

export default caxri;

import type { SourceControlProvider } from './view-providers.js';
import type { WorkspaceGit } from './workspace.js';

export type {
    ControlledViewProviderResult,
    SourceControlAction,
    SourceControlActionEffect,
    SourceControlActionResult,
    SourceControlChange,
    SourceControlCommandBinding,
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
    constructor(readonly id: string) {}
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
 * Bounded interactive content for a TreeItem hover card. Text is rendered literally and URLs are validated by the
 * Extension Host before reaching the Renderer, so extensions cannot inject HTML, scripts, or command links.
 */
export interface TreeItemRichTooltip {
    kind: 'rich';
    title: string;
    /**
     * Prose that explains the title, such as a provider error's recovery hint. Structured facts belong in `rows`.
     */
    description?: string;
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

export interface ExtensionContext {
    readonly extensionId: string;
    readonly generation: number;
    readonly subscriptions: DisposableLike[];
}

export type ProjectStatusState = 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';

export interface ProjectStatusCheck {
    name: string;
    state: ProjectStatusState;
    url?: string;
    durationMs?: number;
}

export interface ProjectStatusLinearIssue {
    identifier: string;
    title?: string;
    url?: string;
    state?: string;
    stateType?:
        'backlog' | 'canceled' | 'completed' | 'duplicate' | 'started' | 'triage' | 'unstarted';
}

export interface ProjectStatusDeployment {
    environment: 'production' | 'preview';
    hostname: string;
    state: ProjectStatusState;
    url: string;
    inspectorUrl?: string;
    createdAt?: number;
}

export interface ProjectStatusError {
    source: 'github' | 'linear' | 'vercel';
    message: string;
    hint: string;
    detailsView?: 'logs';
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
    pullRequest?: {
        number: number;
        title: string;
        url: string;
        state: ProjectStatusState;
        checks: ProjectStatusCheck[];
        hiddenCheckCount: number;
    };
    linearIssues: ProjectStatusLinearIssue[];
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
});

export default caxri;

import type { ResourceExplorerProvider, SourceControlProvider } from './view-providers.js';
import type { WorkspaceFileChange, WorkspaceFileSystem, WorkspaceGit } from './workspace.js';

export type {
    ControlledViewProviderResult,
    ResourceExplorerChange,
    ResourceExplorerProvider,
    SourceControlChange,
    SourceControlMode,
    SourceControlProvider,
} from './view-providers.js';
export type {
    FileEntry,
    FileMutationOperation,
    FileSearchMatch,
    FileSearchResult,
    GitCommit,
    GitCommitDetails,
    GitCommitFile,
    GitCommitPage,
    GitFileStatus,
    GitPullRequestChanges,
    GitRepositorySummary,
    GitSummary,
    MovedFileEntry,
    MutableFileEntry,
    WorkspaceFileChange,
    WorkspaceFileSystem,
    WorkspaceGit,
} from './workspace.js';

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

export interface Command {
    command: string;
    title: string;
    arguments?: readonly unknown[];
}

export class TreeItem {
    id?: string;
    description?: string;
    tooltip?: string;
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

export interface ProjectStatusRequestOptions {
    /**
     * A unique, bounded token bypasses the settled Runtime cache exactly once.
     */
    refreshToken?: string;
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
        registerResourceExplorerProvider(
            viewId: string,
            provider: ResourceExplorerProvider,
        ): Disposable;
        registerSourceControlProvider(viewId: string, provider: SourceControlProvider): Disposable;
    };
    readonly workspace: {
        readonly onDidChangeActiveContext: Event<void>;
        readonly onDidChangeFiles: Event<WorkspaceFileChange>;
        readonly onDidChangeGit: Event<void>;
        readonly onDidChangeProjectStatus: Event<void>;
        readonly fs: WorkspaceFileSystem;
        readonly git: WorkspaceGit;
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
        registerResourceExplorerProvider: () =>
            unavailable('views.registerResourceExplorerProvider'),
        registerSourceControlProvider: () => unavailable('views.registerSourceControlProvider'),
        registerTreeDataProvider: () => unavailable('views.registerTreeDataProvider'),
    }),
    workspace: Object.freeze({
        onDidChangeActiveContext: outsideHostEvent<void>(),
        onDidChangeFiles: outsideHostEvent<WorkspaceFileChange>(),
        onDidChangeGit: outsideHostEvent<void>(),
        onDidChangeProjectStatus: outsideHostEvent<void>(),
        fs: Object.freeze({
            acknowledgeOperation: () => unavailable('workspace.fs.acknowledgeOperation'),
            cancelOperation: () => unavailable('workspace.fs.cancelOperation'),
            copy: () => unavailable('workspace.fs.copy'),
            create: () => unavailable('workspace.fs.create'),
            getOperation: () => unavailable('workspace.fs.getOperation'),
            list: () => unavailable('workspace.fs.list'),
            listOperations: () => unavailable('workspace.fs.listOperations'),
            move: () => unavailable('workspace.fs.move'),
            rename: () => unavailable('workspace.fs.rename'),
            reveal: () => unavailable('workspace.fs.reveal'),
            search: () => unavailable('workspace.fs.search'),
            trash: () => unavailable('workspace.fs.trash'),
        }),
        git: Object.freeze({
            commits: () => unavailable('workspace.git.commits'),
            commitDetails: () => unavailable('workspace.git.commitDetails'),
            discard: () => unavailable('workspace.git.discard'),
            pullRequestChanges: () => unavailable('workspace.git.pullRequestChanges'),
            remoteHost: () => unavailable('workspace.git.remoteHost'),
            summary: () => unavailable('workspace.git.summary'),
            sync: () => unavailable('workspace.git.sync'),
        }),
        getProjectStatus: () => unavailable('workspace.getProjectStatus'),
    }),
});

export default caxri;

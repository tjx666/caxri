import type { CancellationToken, DisposableLike, Event } from './events.js';
import { Disposable } from './events.js';
import type { ProjectStatusSummary } from './project-status.js';
import type { Command, TreeItemAction, TreeItemRichTooltip } from './tree-item-actions.js';
import type { SourceControlProvider } from './view-providers.js';
import type { WorkspaceGit } from './workspace.js';

export type { CancellationToken, DisposableLike, Event } from './events.js';
export { CancellationTokenSource, Disposable, EventEmitter } from './events.js';
export type {
    AcceptanceStatus,
    AcceptanceVerdict,
    ProjectStatusAcceptance,
    ProjectStatusCheck,
    ProjectStatusCodexReview,
    ProjectStatusDeployment,
    ProjectStatusDeploymentCommit,
    ProjectStatusError,
    ProjectStatusLinearIssue,
    ProjectStatusRepository,
    ProjectStatusReviewThread,
    ProjectStatusState,
    ProjectStatusSummary,
    PullRequestMergeBlocker,
    PullRequestMergeState,
} from './project-status.js';
export type {
    Command,
    TreeItemAction,
    TreeItemActionConfirmation,
    TreeItemActionFeedback,
    TreeItemActionTone,
    TreeItemRichTooltip,
    TreeItemTooltipRow,
    TreeItemTooltipTone,
} from './tree-item-actions.js';
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
    SourceControlLineStats,
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
    GitDetachedHead,
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

export class ThemeIcon {
    constructor(
        /**
         * Workbench-owned glyph id. The Workbench, not the extension, decides what it looks like.
         */
        readonly id: string,
        /**
         * Optional `#RRGGBB` tint, for an icon standing in for content whose palette an external system owns, a Linear
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
    /**
     * Inline actions, in display order. They run independently of `command`, which stays the row's own activation.
     */
    actions?: readonly TreeItemAction[];
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
 * Report meaning, not appearance: the Workbench picks the icon and the fill, so a container never shows two views'
 * badges in two unrelated colors. `count` is a plain tally. `error` and `warning` are severities: the Workbench draws
 * its own fixed glyph for them, so they stay legible without relying on color.
 *
 * A severity deliberately has no `count` field. A glyph and a digit cannot share one chip, so a counted severity would
 * fall back to a digit and leave the fill as the only thing separating "5 changes" from "5 failures": nothing to a
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

/**
 * What a command may resolve with. `message` is a short success sentence (`Squash-merged #123`) that the Workbench
 * shows as a toast; it is trimmed and capped at 200 characters. Resolve with nothing when there is nothing to say. A
 * failure is a thrown error, never a message.
 */
export interface CommandResult {
    message: string;
}

export interface CaxriApi {
    readonly commands: {
        registerCommand(
            commandId: string,
            callback: (
                ...arguments_: readonly unknown[]
            ) => CommandResult | void | Promise<CommandResult | void>,
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
     * Throw this instead of your own `GENERATION_EXPIRED` whenever the staleness is your extension's own bookkeeping, a
     * snapshot superseded by a newer `provideView`, an action carrying a revision you no longer serve. Caxri cannot see
     * your revision, so an equivalent error you construct yourself is indistinguishable from a real failure and is
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
            mergePullRequest: () => unavailable('workspace.git.mergePullRequest'),
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
     * registered as a declared non-fault: outside the Extension Host there is no classifier to declare it to, and an
     * unregistered error is classified exactly as it was before this contract existed.
     */
    supersededError: (message: string) =>
        Object.assign(new Error(message), { code: 'GENERATION_EXPIRED' }),
});

export default caxri;

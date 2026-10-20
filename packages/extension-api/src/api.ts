import type { Disposable, DisposableLike, Event } from './events.js';
import type { ProjectStatusSummary } from './project-status.js';
import type { TreeDataProvider, ViewBadgeProvider } from './tree.js';
import type { SourceControlProvider } from './view-providers.js';
import type { WorkspaceGit } from './workspace.js';

export type GlobPatternSettings = Readonly<Record<string, boolean>>;

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

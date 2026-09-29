import type { CancellationToken, Event } from './index.js';

/**
 * Controlled views require a concrete protocol value; unlike tree branches, `null` never means "no children".
 */
export type ControlledViewProviderResult<T> = T | Promise<T>;

export type SourceControlViewIcon =
    { kind: 'theme'; id: string } | { kind: 'file-type'; name: string };

export interface SourceControlCommandBinding {
    id: string;
    /**
     * At most 32 inert values; the provider, not Renderer, interprets them.
     */
    arguments?: readonly unknown[];
}

export interface SourceControlAction {
    id: string;
    label: string;
    icon: SourceControlViewIcon;
    command: SourceControlCommandBinding;
    accessibilityLabel?: string;
    tooltip?: string;
    disabled?: boolean;
    /**
     * Whether this toggle-style action currently represents an active state.
     */
    pressed?: boolean;
    progressLabel?: string;
    emphasis?: 'danger';
    errorMessage?: string;
}

export interface SourceControlMode {
    id: string;
    label: string;
    icon: SourceControlViewIcon;
    command: SourceControlCommandBinding;
}

export interface SourceControlResourceDecoration {
    identifier: string;
    label: string;
    tone: 'danger' | 'success' | 'warning';
}

export interface SourceControlLineStats {
    additions: number;
    deletions: number;
}

export interface SourceControlResource {
    /**
     * Stable provider identity, at most 480 characters.
     */
    id: string;
    /**
     * Presentational text, at most 1,024 characters.
     */
    label: string;
    description?: string;
    /**
     * Presentational text, at most 4,096 characters.
     */
    tooltip: string;
    /**
     * Presentational text, at most 1,024 characters.
     */
    accessibilityLabel: string;
    icon: SourceControlViewIcon;
    /**
     * Presentational tree grouping path, at most 4,096 characters; never an authorization input.
     */
    path: string;
    decoration?: SourceControlResourceDecoration;
    /**
     * Lines the change adds and deletes, shown beside the resource and summed into its tree directories. Omit it when
     * the provider did not measure the change.
     */
    lineStats?: SourceControlLineStats;
    /**
     * Generic editor target, at most 8,192 characters. Omit it when no bounded target can be represented.
     */
    editorResource?: string;
    action?: SourceControlAction;
    /**
     * At most 32 secondary actions.
     */
    actions?: SourceControlAction[];
}

export interface SourceControlGroup {
    id: string;
    label: string;
    count: number;
    hiddenCount?: number;
    expandedByDefault: boolean;
    emptyMessage: string;
    /**
     * `emptyMessage` describes work still in progress, so the Workbench pairs it with a progress indicator.
     */
    isLoading?: boolean;
    truncationMessage?: string;
    actions: SourceControlAction[];
    resources: SourceControlResource[];
}

export interface SourceControlHistoryDescriptor {
    id: string;
    label: string;
    command: SourceControlCommandBinding;
    pathInputLabel: string;
    pathInputPlaceholder: string;
    clearPathLabel: string;
    loadingMessage: string;
    emptyMessage: string;
    loadMoreLabel: string;
    loadingMoreLabel: string;
    loadErrorMessage: string;
    detailsLoadingMessage: string;
    detailsErrorMessage: string;
    detailsLabel: string;
    detailsEmptyMessage: string;
    detailsTruncatedMessage: string;
    itemAccessibilityLabelPrefix: string;
    itemActivation?: 'action';
    pageSize: number;
    revision?: string;
}

export interface SourceControlFileHistory {
    label: string;
    description?: string;
    tooltip?: string;
    emptyMessage: string;
    path?: string;
    history: SourceControlHistoryDescriptor;
}

export interface SourceControlExternalLink {
    url: string;
    /**
     * Names the destination in the row's tooltip and accessible description, so the modifier gesture is discoverable
     * without a visible link glyph.
     */
    label: string;
}

export interface SourceControlProviderModel {
    id: string;
    label: string;
    kindLabel?: string;
    icon: SourceControlViewIcon;
    tooltip: string;
    /**
     * Absolute filesystem root of the repository this provider owns, used only to resolve a provider-relative resource
     * path back to an absolute one. `tooltip` is free display text and must never be read as a path. Omit it when the
     * provider has no filesystem root; consumers then disable path-dependent affordances such as drag-to-Terminal
     * instead of guessing.
     */
    rootPath?: string;
    /**
     * What the repository has checked out — a branch, or a name for a detached commit — shown as the section's first
     * row and allowed to ellipsize. Empty hides that row, for when it would only repeat `label`. Prose that a provider
     * wants beside the row belongs in `descriptionTooltip`.
     */
    description: string;
    /**
     * Glyph of the description row: a branch, or a single commit for a detached HEAD.
     */
    descriptionKind: 'branch' | 'commit';
    /**
     * Short trailing status of the description row, such as unsynced commit counts (`↑2 ↓1`) or `detached`.
     */
    descriptionBadge?: string;
    descriptionAccessibilityLabel: string;
    descriptionTooltip: string;
    /**
     * Trailing counts; empty when every count is zero, since a synced, clean repository shows no count noise.
     */
    countLabel: string;
    /**
     * Web page describing the changes this provider is currently showing — the pull request in Pull Request mode.
     * Alt-clicking the provider row or its group caption opens it in the default browser, so the panel never has to
     * spend row width on a link affordance that is empty in most modes.
     */
    externalLink?: SourceControlExternalLink;
    /**
     * Uncommitted work the selected mode is not showing, plus the mode that does show it. Deliberately not a
     * `SourceControlAction`: changing the panel's mode is the mode switch's job, and routing it through the action
     * registry instead would give the same state change two dispatch paths.
     */
    uncommittedNotice?: {
        modeId: string;
        accessibilityLabel: string;
        tooltip: string;
    };
    expandedByDefault: boolean;
    actions: SourceControlAction[];
    groups: SourceControlGroup[];
    history?: SourceControlHistoryDescriptor;
}

export interface SourceControlViewModel {
    revision: string;
    title: string;
    accessibilityLabel: string;
    modeAccessibilityLabel: string;
    modes: SourceControlMode[];
    selectedModeId: string;
    refreshAction: SourceControlAction;
    /**
     * Generic actions displayed in the Source Control header.
     */
    headerActions?: SourceControlAction[];
    fileHistory?: SourceControlFileHistory;
    providers: SourceControlProviderModel[];
    emptyMessage?: string;
    /**
     * Distinguishes a missing repository from a failed Git read for the panel's recovery state.
     */
    emptyKind?: 'no-repository' | 'unavailable';
    truncationMessage?: string;
}

export interface SourceControlHistoryItem {
    id: string;
    label: string;
    description: string;
    timestamp: number;
    tooltipTimestamp: string;
    author: string;
    authorFallback: string;
    avatarUrl?: string;
    decorations: string[];
    body?: string;
    action?: SourceControlAction;
}

export interface SourceControlHistoryPage {
    revision: string;
    items: SourceControlHistoryItem[];
    nextOffset?: number;
}

export interface SourceControlHistoryDetails {
    revision: string;
    itemId: string;
    summary: string;
    additions: number;
    deletions: number;
    resources: SourceControlResource[];
    truncated: boolean;
    /**
     * Number of loaded changed files omitted by visibility settings.
     */
    hiddenCount?: number;
}

export type SourceControlActionEffect =
    { kind: 'open-editor'; resource: string } | { kind: 'toast'; message: string; tone: 'success' };

export interface SourceControlActionResult {
    revision: string;
    effects: SourceControlActionEffect[];
    refresh: boolean;
}

export type SourceControlChange =
    { kind: 'content' } | { kind: 'refresh' } | { kind: 'selection'; selectedModeId: string };

export interface SourceControlProvider {
    readonly onDidChange?: Event<SourceControlChange>;
    provideView(
        request: {
            scopeId: string;
            activeResource?: string;
            preferredModeId?: string;
            refresh: number;
            revision?: string;
        },
        token: CancellationToken,
    ): ControlledViewProviderResult<SourceControlViewModel>;
    provideHistoryPage(
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
    ): ControlledViewProviderResult<SourceControlHistoryPage>;
    provideHistoryDetails(
        request: {
            historyId: string;
            itemId: string;
            scopeId: string;
            path?: string;
            revision: string;
        },
        token: CancellationToken,
    ): ControlledViewProviderResult<SourceControlHistoryDetails>;
    runAction(
        request: { actionId: string; scopeId: string; revision: string },
        token: CancellationToken,
    ): ControlledViewProviderResult<SourceControlActionResult>;
}

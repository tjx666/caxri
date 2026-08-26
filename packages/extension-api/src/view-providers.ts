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
     * Generic editor target, at most 8,192 characters. Omit it when no bounded target can be represented.
     */
    editorResource?: string;
    navigationTargetId?: string;
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
    expandedByDefault: boolean;
    emptyMessage: string;
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
    pageSize: number;
    revision?: string;
}

export interface SourceControlProviderModel {
    id: string;
    label: string;
    kindLabel?: string;
    icon: SourceControlViewIcon;
    tooltip: string;
    description: string;
    descriptionAccessibilityLabel: string;
    descriptionTooltip: string;
    countLabel: string;
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
    providers: SourceControlProviderModel[];
    emptyMessage?: string;
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
}

export type SourceControlActionEffect =
    | { kind: 'focus'; targetId: string }
    | { kind: 'open-editor'; resource: string }
    | { kind: 'toast'; message: string; tone: 'success' };

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
            preferredModeId?: string;
            refresh: number;
            revision?: string;
        },
        token: CancellationToken,
    ): ControlledViewProviderResult<SourceControlViewModel>;
    provideHistoryPage(
        request: {
            historyId: string;
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

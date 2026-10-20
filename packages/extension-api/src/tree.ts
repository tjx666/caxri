import type { CancellationToken, Event } from './events.js';
import type { Command, TreeItemAction, TreeItemRichTooltip } from './tree-item-actions.js';

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

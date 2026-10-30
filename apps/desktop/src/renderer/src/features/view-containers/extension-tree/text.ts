import type { TreeItemDto } from '@caxri/protocol';

import type { Translate } from '../../../i18n';
import {
    localizeExtensionParts,
    localizeExtensionSentences,
    localizeExtensionText,
} from '../extension-text';

/**
 * Tree views whose copy the bundled Status extension sends in English. Other extensions' views keep their own copy.
 */
const LOCALIZED_TREE_VIEWS: ReadonlySet<string> = new Set(['caxri.project-status.overview']);

/**
 * Hover-card rows whose value is the extension's own wording (`Ready to merge`, `2 commits back`) rather than data.
 * Every other row value (branch names, commit subjects, paths, timestamps) stays as sent, so a branch that happens to
 * be named like a catalog sentence is never rewritten.
 */
const CHROME_VALUE_ROWS: ReadonlySet<string> = new Set([
    'checks',
    'inspect',
    'merge',
    'position',
    'pull request',
    'round',
    'since',
    'verdict',
]);

type TreeItemActionDto = NonNullable<TreeItemDto['actions']>[number];

function localizeAction(action: TreeItemActionDto, t: Translate): TreeItemActionDto {
    const { confirmation, feedback } = action;
    return {
        ...action,
        command: { ...action.command, title: localizeExtensionText(action.command.title, t) },
        ...(action.label !== undefined && { label: localizeExtensionText(action.label, t) }),
        ...(action.tooltip !== undefined && {
            tooltip: localizeExtensionSentences(action.tooltip, t),
        }),
        ...(confirmation && {
            confirmation: {
                title: localizeExtensionText(confirmation.title, t),
                message: localizeExtensionSentences(confirmation.message, t),
                confirmLabel: localizeExtensionText(confirmation.confirmLabel, t),
            },
        }),
        ...(feedback && {
            feedback: {
                ...feedback,
                ...(feedback.success !== undefined && {
                    success: localizeExtensionText(feedback.success, t),
                }),
                ...(feedback.failure !== undefined && {
                    failure: localizeExtensionText(feedback.failure, t),
                }),
            },
        }),
    };
}

function localizeTooltip(tooltip: NonNullable<TreeItemDto['tooltip']>, t: Translate) {
    if (typeof tooltip === 'string') return localizeExtensionParts(tooltip, t);
    return {
        ...tooltip,
        title: localizeExtensionText(tooltip.title, t),
        ...(tooltip.description !== undefined && {
            description: localizeExtensionSentences(tooltip.description, t),
        }),
        ...(tooltip.badge && {
            badge: { ...tooltip.badge, label: localizeExtensionParts(tooltip.badge.label, t) },
        }),
        rows: tooltip.rows.map((row) => ({
            ...row,
            label: localizeExtensionText(row.label, t),
            ...(CHROME_VALUE_ROWS.has(row.label) && {
                value: localizeExtensionParts(row.value, t),
            }),
        })),
    };
}

/**
 * One Status row in the interface language. Only the extension's own chrome (empty-state messages, row labels in the
 * hover card, publication words, command titles) matches the catalog; repository names, branches, pull request titles,
 * and check names pass through untouched.
 */
function localizeTreeItem(item: TreeItemDto, t: Translate): TreeItemDto {
    return {
        ...item,
        label: localizeExtensionText(item.label, t),
        ...(item.description !== undefined && {
            description: localizeExtensionParts(item.description, t),
        }),
        accessibilityLabel: localizeExtensionParts(item.accessibilityLabel, t),
        ...(item.tooltip !== undefined && { tooltip: localizeTooltip(item.tooltip, t) }),
        ...(item.actions && {
            actions: item.actions.map((action) => localizeAction(action, t)),
        }),
        ...(item.command && {
            command: { ...item.command, title: localizeExtensionText(item.command.title, t) },
        }),
    };
}

/**
 * The loaded branches of a tree view, translated when the view belongs to a bundled extension. Returns the same map for
 * every other view so row identity is preserved.
 */
export function localizeTreeChildren(
    viewId: string,
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    t: Translate,
): ReadonlyMap<string, readonly TreeItemDto[]> {
    if (!LOCALIZED_TREE_VIEWS.has(viewId)) return children;
    return new Map(
        [...children].map(([handle, items]) => [
            handle,
            items.map((item) => localizeTreeItem(item, t)),
        ]),
    );
}

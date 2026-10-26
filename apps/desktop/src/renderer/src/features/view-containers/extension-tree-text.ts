import type { TreeItemDto } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { localizeExtensionParts, localizeExtensionText } from './extension-text';

/**
 * Tree views whose copy the bundled Status extension sends in English. Other extensions' views keep their own copy.
 */
const LOCALIZED_TREE_VIEWS: ReadonlySet<string> = new Set(['caxri.project-status.overview']);

function localizeTooltip(tooltip: NonNullable<TreeItemDto['tooltip']>, t: Translate) {
    if (typeof tooltip === 'string') return localizeExtensionParts(tooltip, t);
    return {
        ...tooltip,
        ...(tooltip.description !== undefined && {
            description: localizeExtensionText(tooltip.description, t),
        }),
        ...(tooltip.badge && {
            badge: { ...tooltip.badge, label: localizeExtensionParts(tooltip.badge.label, t) },
        }),
        rows: tooltip.rows.map((row) => ({ ...row, label: localizeExtensionText(row.label, t) })),
    };
}

/**
 * One Status row in the interface language. Only the extension's own chrome (empty-state messages, row labels in the
 * hover card, publication words, command titles) matches the catalog; repository names, branches, pull request titles,
 * and check names pass through untouched.
 */
function localizeTreeItem(item: TreeItemDto, t: Translate = translate): TreeItemDto {
    return {
        ...item,
        label: localizeExtensionText(item.label, t),
        ...(item.description !== undefined && {
            description: localizeExtensionParts(item.description, t),
        }),
        accessibilityLabel: localizeExtensionParts(item.accessibilityLabel, t),
        ...(item.tooltip !== undefined && { tooltip: localizeTooltip(item.tooltip, t) }),
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
    t: Translate = translate,
): ReadonlyMap<string, readonly TreeItemDto[]> {
    if (!LOCALIZED_TREE_VIEWS.has(viewId)) return children;
    return new Map(
        [...children].map(([handle, items]) => [
            handle,
            items.map((item) => localizeTreeItem(item, t)),
        ]),
    );
}

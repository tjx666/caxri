import type { Command, TreeItemAction, TreeItemRichTooltip, TreeItemVariant } from 'caxri';
import { l10n, ThemeIcon, TreeItem, TreeItemCollapsibleState } from 'caxri';

import type { StatusTooltip } from './status-presentation';
import { linkText } from './status-presentation';

/**
 * The row builder every Status subtree shares, split from `./status-tree.ts` so the tree file stays about which rows a
 * repository gets rather than how one row is assembled.
 */
export interface StatusNode {
    item: TreeItem;
    children?: readonly StatusNode[];
}

export function item(
    id: string,
    label: string,
    options: {
        accessibilityLabel?: string;
        actions?: readonly TreeItemAction[];
        children?: readonly StatusNode[];
        collapsibleState?: TreeItemCollapsibleState;
        command?: Command;
        description?: string;
        icon?: string;
        /**
         * `#RRGGBB` tint for `icon`, for a row standing in for content whose palette an external system owns.
         */
        iconColor?: string;
        trailingIcon?: string;
        tooltip?: StatusTooltip;
        url?: string;
        variant?: TreeItemVariant;
    } = {},
): StatusNode {
    const treeItem = new TreeItem(
        label,
        options.collapsibleState ??
            (options.children?.length
                ? TreeItemCollapsibleState.Collapsed
                : TreeItemCollapsibleState.None),
    );
    treeItem.id = id;
    treeItem.variant = options.variant;
    treeItem.description = options.description;
    treeItem.tooltip = richTooltip(label, options.tooltip, options.url);
    treeItem.accessibilityInformation = {
        label:
            options.accessibilityLabel ?? [label, options.description].filter(Boolean).join(', '),
    };
    if (options.icon) treeItem.iconPath = new ThemeIcon(options.icon, options.iconColor);
    if (options.trailingIcon) treeItem.trailingIcon = new ThemeIcon(options.trailingIcon);
    if (options.url) {
        treeItem.command = {
            command: 'caxri.openExternal',
            title: l10n.t('Open {label}', { label }),
            arguments: [options.url],
        };
    }
    if (options.command) treeItem.command = options.command;
    if (options.actions?.length) treeItem.actions = options.actions;
    return { item: treeItem, children: options.children };
}

/**
 * Every Status row wears the same hover card, so the panel never mixes a rich card with a plain multi-line string. The
 * row's own destination becomes the trailing `link` row unless the caller already published that URL under a more
 * specific label, which keeps a deployment from repeating its alias.
 */
function richTooltip(
    label: string,
    tooltip: StatusTooltip | undefined,
    url: string | undefined,
): TreeItemRichTooltip {
    const rows = tooltip?.rows ?? [];
    return {
        kind: 'rich',
        title: tooltip?.title ?? label,
        ...(tooltip?.description && { description: tooltip.description }),
        ...(tooltip?.markdown && { markdown: tooltip.markdown }),
        ...(tooltip?.badge && { badge: tooltip.badge }),
        rows:
            url && rows.every((row) => row.url !== url)
                ? [...rows, { label: l10n.t('link'), value: linkText(url), url }]
                : rows,
    };
}

import type { TreeItemDto } from '@caxri/protocol';
import { treeItemSchema } from '@caxri/protocol';
import type { ThemeIcon, TreeItem } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';

function collapsibleState(value: number): TreeItemDto['collapsibleState'] {
    if (value === TreeItemCollapsibleState.Collapsed) return 'collapsed';
    if (value === TreeItemCollapsibleState.Expanded) return 'expanded';
    return 'none';
}

/**
 * `treeItemSchema` below validates the color, so a provider that tints an icon with anything but `#RRGGBB` fails its
 * whole `getChildren` batch rather than smuggling an unchecked string into a Renderer `style` attribute.
 */
function themeIcon(icon: ThemeIcon) {
    return { kind: 'theme', id: icon.id, ...(icon.color && { color: icon.color }) };
}

/**
 * Validate provider-owned presentation before it crosses the Extension Host boundary.
 */
export function serializeTreeItem(handle: string, item: TreeItem): TreeItemDto {
    return treeItemSchema.parse({
        handle,
        ...(item.id && { id: item.id }),
        ...(item.variant && { variant: item.variant }),
        label: item.label,
        ...(item.description && { description: item.description }),
        ...(item.tooltip && { tooltip: item.tooltip }),
        accessibilityLabel: item.accessibilityInformation?.label ?? item.label,
        collapsibleState: collapsibleState(item.collapsibleState),
        ...(item.iconPath && { icon: themeIcon(item.iconPath) }),
        ...(item.trailingIcon && { trailingIcon: themeIcon(item.trailingIcon) }),
        ...(item.command && {
            command: {
                id: item.command.command,
                title: item.command.title,
                ...(item.command.arguments && { arguments: [...item.command.arguments] }),
            },
        }),
    });
}

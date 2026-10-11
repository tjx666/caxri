import type { TreeItemDto } from '@caxri/protocol';
import { treeItemSchema } from '@caxri/protocol';
import type { Command, ThemeIcon, TreeItem } from 'caxri';
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

function command(value: Command) {
    return {
        id: value.command,
        title: value.title,
        ...(value.arguments && { arguments: [...value.arguments] }),
    };
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
        ...(item.command && { command: command(item.command) }),
        ...(item.actions?.length && {
            actions: item.actions.map((action) => ({
                command: command(action.command),
                icon: themeIcon(action.icon),
                ...(action.label && { label: action.label }),
                ...(action.tone && { tone: action.tone }),
                ...(action.confirmation && {
                    confirmation: {
                        title: action.confirmation.title,
                        message: action.confirmation.message,
                        confirmLabel: action.confirmation.confirmLabel,
                    },
                }),
                ...(action.tooltip && { tooltip: action.tooltip }),
                ...(action.feedback && {
                    feedback: {
                        ...(action.feedback.success && { success: action.feedback.success }),
                        ...(action.feedback.failure && { failure: action.feedback.failure }),
                        ...(action.feedback.githubUrl && { githubUrl: action.feedback.githubUrl }),
                    },
                }),
            })),
        }),
    });
}

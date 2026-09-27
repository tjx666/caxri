import type { MobilePanelViewKind, TreeItemDto, ViewDescriptor, ViewIcon } from '@caxri/protocol';

/**
 * Drops a `resource` (data URL) icon rather than projecting it. Every core-contributed secondary-sidebar container uses
 * a `builtin` or `theme` icon today, and inlining an extension-supplied image is not yet part of the mobile read
 * surface.
 */
export const projectMobileIcon = (
    icon: ViewIcon | undefined,
): { kind: 'builtin' | 'theme'; id: string; color?: string } | undefined => {
    if (!icon || icon.kind === 'resource') return undefined;
    return icon.kind === 'theme' && icon.color
        ? { kind: icon.kind, id: icon.id, color: icon.color }
        : { kind: icon.kind, id: icon.id };
};

export const mobilePanelViewKind = (viewKind: ViewDescriptor['viewKind']): MobilePanelViewKind => {
    switch (viewKind.kind) {
        case 'resource-explorer':
            return 'files';
        case 'source-control':
            return 'changes';
        case 'tree':
            return 'tree';
        default:
            return 'unsupported';
    }
};

export const projectMobileTreeItem = (item: TreeItemDto) => ({
    handle: item.handle,
    label: item.label,
    ...(item.description !== undefined && { description: item.description }),
    ...(projectMobileIcon(item.icon) && { icon: projectMobileIcon(item.icon) }),
    collapsibleState: item.collapsibleState,
});

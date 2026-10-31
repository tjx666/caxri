import type {
    MobilePanelViewKind,
    MobileTreeItemAction,
    TreeItemDto,
    ViewDescriptor,
    ViewIcon,
} from '@caxri/protocol';

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

/**
 * The Workbench command a provider uses for "open this page"; the phone opens it in the system browser.
 */
const OPEN_EXTERNAL_COMMAND = 'caxri.openExternal';

type TreeItemAction = NonNullable<TreeItemDto['actions']>[number];

/**
 * Whether a phone can run this inline action: an extension's own command (it runs in the Extension Host through
 * `mobile.tree.executeCommand`, as Desktop runs it) or `caxri.openExternal`. Every other Workbench command, such as
 * `caxri.sendToAgent` or `caxri.showLogs`, is resolved by the Desktop Renderer and has no phone equivalent yet, so its
 * button is dropped rather than shown dead.
 */
const canPhoneRunTreeAction = (
    action: TreeItemAction,
    isExtensionCommand: (commandId: string) => boolean,
): boolean => action.command.id === OPEN_EXTERNAL_COMMAND || isExtensionCommand(action.command.id);

const projectMobileTreeAction = ({ icon, ...action }: TreeItemAction): MobileTreeItemAction => ({
    ...action,
    ...(projectMobileIcon(icon) && { icon: projectMobileIcon(icon) }),
});

export const projectMobileTreeItem = (
    item: TreeItemDto,
    isExtensionCommand: (commandId: string) => boolean,
) => {
    const actions = (item.actions ?? [])
        .filter((action) => canPhoneRunTreeAction(action, isExtensionCommand))
        .map(projectMobileTreeAction);
    return {
        handle: item.handle,
        label: item.label,
        ...(item.description !== undefined && { description: item.description }),
        ...(projectMobileIcon(item.icon) && { icon: projectMobileIcon(item.icon) }),
        collapsibleState: item.collapsibleState,
        ...(actions.length > 0 && { actions }),
    };
};

import type {
    ContributedCommandDescriptor,
    ExtensionViewActionRole,
    Keybinding,
    ViewContainerDescriptor,
    ViewDescriptor,
} from '@caxri/protocol';

export interface WorkbenchCoreCommandDefinition {
    id: string;
    title: string;
    category: string;
    description: string;
    allowInEditable?: boolean;
    nativeMenu?: { menu: 'view'; group: number; order: number };
}

export interface WorkbenchCoreContribution {
    id: string;
    order: number;
    container: ViewContainerDescriptor;
    views: readonly ViewDescriptor[];
    commands: readonly ContributedCommandDescriptor[];
    keybindings: readonly Keybinding[];
}

export const filesCoreCommandDefinitions = [
    {
        id: 'secondarySidebar.showFiles',
        title: 'Show Files',
        category: 'Secondary Side Bar',
        description: 'Show Files in the Secondary Side Bar',
        allowInEditable: true,
    },
    {
        id: 'secondarySidebar.searchFiles',
        title: 'Search Files',
        category: 'Secondary Side Bar',
        description: 'Search files in the selected Project',
        allowInEditable: true,
        nativeMenu: { menu: 'view', group: 0, order: 0 },
    },
] as const satisfies readonly WorkbenchCoreCommandDefinition[];

export const filesCoreKeybindings = [
    { key: 'cmd+1', command: 'secondarySidebar.showFiles' },
    { key: 'cmd+shift+f', command: 'secondarySidebar.searchFiles' },
] as const satisfies readonly Keybinding[];

const filesCoreActions = [
    { commandId: 'caxri.files.newFile', role: 'resource.createFile' },
    { commandId: 'caxri.files.newFolder', role: 'resource.createFolder' },
    { commandId: 'secondarySidebar.searchFiles', role: 'resource.search' },
    { commandId: 'caxri.files.collapseFolders', role: 'resource.collapse' },
    { commandId: 'caxri.files.refresh', role: 'resource.refresh' },
] as const satisfies ReadonlyArray<{
    commandId: string;
    role: ExtensionViewActionRole;
}>;

const filesCoreCommands = [
    ...filesCoreCommandDefinitions.map(({ id, title }) => ({
        id,
        title,
        source: { kind: 'core' as const },
        lifecycle: 'core' as const,
        allowInEditable: true,
    })),
    ...(
        [
            ['caxri.files.newFile', 'New File'],
            ['caxri.files.newFolder', 'New Folder'],
            ['caxri.files.collapseFolders', 'Collapse Folders'],
            ['caxri.files.refresh', 'Refresh Files'],
        ] as const
    ).map(([id, title]) => ({
        id,
        title,
        source: { kind: 'core' as const },
        lifecycle: 'core' as const,
    })),
] satisfies readonly ContributedCommandDescriptor[];

/**
 * Workbench Core contributions use the same catalog descriptors as extensions while remaining outside discovery,
 * activation, generation, and crash lifecycle. Consumers route by descriptor source and action role, never by the Files
 * product id.
 */
export const workbenchCoreContributions = [
    {
        id: 'workbench.files',
        order: 100,
        container: {
            id: 'caxri.files',
            location: 'secondarySidebar',
            source: { kind: 'core' },
            title: 'Files',
            icon: { kind: 'builtin', id: 'files' },
            commandId: 'secondarySidebar.showFiles',
            lifecycle: 'core',
        },
        views: [
            {
                id: 'caxri.files.explorer',
                containerId: 'caxri.files',
                source: { kind: 'core' },
                title: 'Files',
                viewKind: { kind: 'resource-explorer' },
                actions: [...filesCoreActions],
            },
        ],
        commands: filesCoreCommands,
        keybindings: filesCoreKeybindings,
    },
] as const satisfies readonly WorkbenchCoreContribution[];

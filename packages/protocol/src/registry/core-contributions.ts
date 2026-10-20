import type { Keybinding } from '../domain/domain.js';
import type {
    ContributedCommandDescriptor,
    ExtensionViewActionRole,
    ViewContainerDescriptor,
    ViewDescriptor,
} from '../domain/views.js';

export interface WorkbenchCoreCommandDefinition {
    id: string;
    title: string;
    category: string;
    description: string;
    execution: 'viewCatalog';
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
        execution: 'viewCatalog',
    },
] as const satisfies readonly WorkbenchCoreCommandDefinition[];

/**
 * `cmd+shift+f` stays in the Files contribution's default set even though its command is no longer a Files view
 * command: a keybinding is a key and a command id, and this is still the shortcut a user reaches for from the file
 * tree. Moving it would rewrite the default set's order for no behavioral gain.
 */
export const filesCoreKeybindings = [
    { key: 'cmd+alt+1', command: 'secondarySidebar.showFiles' },
    { key: 'cmd+shift+f', command: 'secondarySidebar.searchFiles' },
] as const satisfies readonly Keybinding[];

const filesCoreActions = [
    { commandId: 'caxri.files.newFile', role: 'resource.createFile' },
    { commandId: 'caxri.files.newFolder', role: 'resource.createFolder' },
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
 *
 * Annotated rather than `as const satisfies` because consumers flatten it: once a literal tuple holds structurally
 * different entries, `flatMap(({ views }) => views)` infers a union of tuples that TypeScript will not widen back into
 * one array, so `apps/server/src/core/extensions/catalog.ts` fails to compile. Nothing needs the literal precision
 * here: every consumer reads these as plain descriptor arrays.
 */
export const workbenchCoreContributions: readonly WorkbenchCoreContribution[] = [
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
];

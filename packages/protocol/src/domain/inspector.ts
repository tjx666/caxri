import { z } from 'zod';

/**
 * Single registration point for Inspector modes and their commands. Renderer panel components are exhaustively keyed by
 * this list, while the command catalog, registry, schema, and defaults derive from it.
 *
 * The Inspector holds hierarchical, navigable surfaces that read well in a narrow vertical rail. Wide, stream- or
 * record-shaped surfaces belong to the Bottom Panel instead (`bottom-panel.ts`).
 */
export const inspectorModeRegistrations = [
    {
        mode: 'files',
        commandId: 'inspector.showFiles',
        commandTitle: 'Show Files',
        commandDescription: 'Show Files in the Inspector',
        defaultKeybinding: 'cmd+1',
    },
    {
        mode: 'git',
        commandId: 'inspector.showGit',
        commandTitle: 'Show Git',
        commandDescription: 'Show Source Control in the Inspector',
        defaultKeybinding: 'cmd+2',
    },
    {
        mode: 'status',
        commandId: 'inspector.showStatus',
        commandTitle: 'Show Project Status',
        commandDescription: 'Show Project Status in the Inspector',
        defaultKeybinding: 'cmd+3',
    },
] as const;

type InspectorModeRegistration = (typeof inspectorModeRegistrations)[number];
export type InspectorMode = InspectorModeRegistration['mode'];
export type InspectorCommandId = InspectorModeRegistration['commandId'];
export type InspectorCommandIdFor<Mode extends InspectorMode> = Extract<
    InspectorModeRegistration,
    { mode: Mode }
>['commandId'];

const inspectorModeIds = inspectorModeRegistrations.map(({ mode }) => mode) as [
    InspectorMode,
    ...InspectorMode[],
];

export const inspectorModeSchema = z.enum(inspectorModeIds);

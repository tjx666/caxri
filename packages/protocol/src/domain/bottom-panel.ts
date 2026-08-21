/**
 * Single registration point for Bottom Panel views and their commands, mirroring `inspector.ts`.
 *
 * The Inspector owns hierarchical, navigable surfaces (file tree, source control, project status) that read well in a
 * narrow vertical rail. The Bottom Panel owns wide, stream- or record-shaped surfaces that need horizontal room instead
 * — the same Sidebar-vs-Panel split VS Code draws. Renderer view components are exhaustively keyed by this list, while
 * the command catalog, shortcuts, and defaults derive from it.
 */
export const bottomPanelViewRegistrations = [
    {
        view: 'logs',
        commandId: 'bottomPanel.showLogs',
        commandTitle: 'Show Logs',
        commandDescription: 'Show structured process logs in the Bottom Panel',
        /**
         * Matches VS Code's Output panel chord, which this view is modeled on.
         */
        defaultKeybinding: 'cmd+shift+u',
    },
    {
        view: 'info',
        commandId: 'bottomPanel.showInfo',
        commandTitle: 'Show Terminal Info',
        commandDescription: 'Show Terminal information in the Bottom Panel',
        defaultKeybinding: 'cmd+shift+y',
    },
] as const;

type BottomPanelViewRegistration = (typeof bottomPanelViewRegistrations)[number];
export type BottomPanelView = BottomPanelViewRegistration['view'];
export type BottomPanelCommandId = BottomPanelViewRegistration['commandId'];
export type BottomPanelCommandIdFor<View extends BottomPanelView> = Extract<
    BottomPanelViewRegistration,
    { view: View }
>['commandId'];

const bottomPanelViewIds = bottomPanelViewRegistrations.map(({ view }) => view) as [
    BottomPanelView,
    ...BottomPanelView[],
];

export const bottomPanelViews: readonly BottomPanelView[] = bottomPanelViewIds;

/**
 * The Bottom Panel's active view is device-local presentation state (`stores/panel-layout.ts`), never written through
 * to the Runtime, so this narrows a persisted `localStorage` string instead of validating an IPC payload.
 */
export function isBottomPanelView(value: unknown): value is BottomPanelView {
    return typeof value === 'string' && (bottomPanelViewIds as readonly string[]).includes(value);
}

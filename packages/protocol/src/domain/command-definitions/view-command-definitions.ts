import type { CommandDefinition } from '../command-catalog.js';

/**
 * Primary Side Bar, zoom, and Zen mode commands: how much of the window's chrome is on screen and at what scale.
 */
export const viewCommandDefinitions: CommandDefinition[] = [
    {
        id: 'primarySidebar.toggle',
        title: 'Toggle Primary Side Bar',
        category: 'View',
        description: 'Show or hide the Primary Side Bar',
        nativeMenu: { menu: 'view', group: 0, order: 1 },
    },
    {
        id: 'primarySidebar.toggleActivity',
        title: 'Toggle Activity',
        category: 'View',
        description:
            'Swap the Primary Side Bar between the Project tree and every Project’s Agent Sessions grouped by what needs attention',
        keywords: ['activity', 'attention', 'unread', 'waiting', 'inbox'],
    },
    {
        id: 'primarySidebar.focus',
        title: 'Focus Primary Side Bar',
        category: 'View',
        description:
            'Move keyboard focus into the Primary Side Bar, revealing it first when hidden',
    },
    {
        id: 'view.zoomIn',
        title: 'Zoom In',
        category: 'View',
        description: 'Enlarge the whole interface by one zoom step',
        keywords: ['zoom', 'bigger', 'larger', 'scale', 'magnify'],
        nativeMenu: { menu: 'view', group: 2, order: 0 },
    },
    {
        id: 'view.zoomOut',
        title: 'Zoom Out',
        category: 'View',
        description: 'Shrink the whole interface by one zoom step',
        keywords: ['zoom', 'smaller', 'scale'],
        nativeMenu: { menu: 'view', group: 2, order: 1 },
    },
    {
        id: 'view.resetZoom',
        title: 'Reset Zoom',
        category: 'View',
        description: 'Return the interface to its original size',
        keywords: ['zoom', 'actual size', 'scale', 'default'],
        nativeMenu: { menu: 'view', group: 2, order: 2 },
    },
    {
        id: 'view.toggleZenMode',
        title: 'Toggle Zen Mode',
        category: 'View',
        description:
            'Hide the side bars, Panel, tab bars, and status bar so only the current Chat or Terminal remains',
        keywords: ['zen', 'focus', 'distraction free', 'minimal', 'hide chrome'],
        nativeMenu: { menu: 'view', group: 0, order: 4 },
    },
];

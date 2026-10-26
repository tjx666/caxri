import type { CommandDefinition } from '../command-catalog.js';

/**
 * The Help menu entries that open a public page or a folder rather than a Workbench surface. Kept beside the catalog
 * instead of inside it so the catalog stays under the source-size ratchet; the catalog spreads them at the position the
 * palette and the native Help menu list them.
 */
export const helpLinkCommandDefinitions: CommandDefinition[] = [
    {
        id: 'help.openDocumentation',
        title: 'Documentation',
        category: 'Help',
        description: 'Open the Caxri getting started guide in your browser',
        keywords: ['docs', 'guide', 'manual', 'getting started'],
        nativeMenu: { menu: 'help', group: 0, order: 1 },
    },
    {
        id: 'help.openReleaseNotes',
        title: 'Release Notes',
        category: 'Help',
        description: 'See what changed in each Caxri release',
        keywords: ['changelog', 'whats new', 'releases'],
        nativeMenu: { menu: 'help', group: 0, order: 2 },
    },
    {
        id: 'help.reportIssue',
        title: 'Report an Issue',
        category: 'Help',
        description: 'Open the Caxri issue tracker in your browser',
        keywords: ['bug', 'feedback', 'github', 'feature request'],
        nativeMenu: { menu: 'help', group: 0, order: 3 },
    },
    {
        id: 'help.revealLogs',
        title: 'Reveal Logs in Finder',
        category: 'Help',
        description: 'Show the Caxri log folder in Finder',
        keywords: ['log', 'diagnostics', 'troubleshooting'],
        nativeMenu: { menu: 'help', group: 0, order: 4 },
    },
];

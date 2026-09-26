import { sortedCopy } from '@caxri/utils';

import { filesCoreCommandDefinitions } from '../registry/core-contributions.js';
import type { CommandId } from './commands.js';

/**
 * Context predicates the palette can evaluate against the currently selected Session so commands only surface when
 * their target state is real. Kept as a small enum rather than a general when-clause expression because the current
 * catalog has only three gated commands; a full evaluator is not warranted yet.
 */
export type CommandWhen =
    'sessionHasLiveAgent' | 'sessionHasDetachedAgent' | 'sessionHasPullRequest';

export interface CommandDefinition {
    id: CommandId;
    title: string;
    category: string;
    description: string;
    /**
     * Static commands execute in the Renderer registry unless their owning View catalog handles them.
     */
    execution?: 'viewCatalog';
    /**
     * Search-only aliases that preserve familiar language without leaking it back into visible command copy.
     */
    keywords?: readonly string[];
    /**
     * Commands that require configured arguments remain available to keybindings but stay out of the palette, whose
     * invocation path cannot supply those arguments.
     */
    requiresArguments?: boolean;
    /**
     * When set, the command palette hides this command unless the predicate is true for the current selection. The
     * command stays reachable through keybindings and native menus, where invocation from an unrelated state is a
     * silent no-op — matching the row-menu's existing disabled affordance.
     */
    when?: CommandWhen;
    nativeMenu?: {
        menu: NativeMenuId;
        group: number;
        order: number;
    };
}

export const nativeMenuIds = [
    'application',
    'project',
    'session',
    'terminal',
    'view',
    'window',
    'help',
] as const;

export type NativeMenuId = (typeof nativeMenuIds)[number];

/**
 * One command catalog supplies the palette, shortcuts, native menus, and command-backed buttons.
 */
export const commandDefinitions: CommandDefinition[] = [
    {
        id: 'project.create',
        title: 'Add Project',
        category: 'Project',
        description: 'Add a folder as a Project',
        nativeMenu: { menu: 'project', group: 0, order: 0 },
    },
    {
        id: 'project.delete',
        title: 'Delete Project',
        category: 'Project',
        description: 'Delete the selected Project from Caxri without touching its files',
    },
    {
        id: 'project.hide',
        title: 'Hide Project',
        category: 'Project',
        description:
            'Hide the selected Project and keep its Sessions; adding the same folder again restores them',
        nativeMenu: { menu: 'project', group: 0, order: 2 },
    },
    {
        id: 'project.openInEditor',
        title: 'Open Project in External Editor',
        category: 'Project',
        description: 'Open the selected Project root in the configured external editor',
        nativeMenu: { menu: 'project', group: 1, order: 0 },
    },
    {
        id: 'project.customizeIcon',
        title: 'Customize Project Icon…',
        category: 'Project',
        description: 'Choose a controlled icon and color for the selected Project',
        nativeMenu: { menu: 'project', group: 1, order: 1 },
    },
    {
        id: 'session.create',
        title: 'New Session',
        category: 'Session',
        description: 'Create a Session in the selected Project',
        nativeMenu: { menu: 'session', group: 0, order: 0 },
    },
    {
        id: 'session.rename',
        title: 'Rename Session',
        category: 'Session',
        description: 'Rename the selected Session in the Primary Side Bar',
        nativeMenu: { menu: 'session', group: 0, order: 1 },
    },
    {
        id: 'session.delete',
        title: 'Delete Session',
        category: 'Session',
        description: 'Delete the selected Session and its Terminals without touching files on disk',
        nativeMenu: { menu: 'session', group: 0, order: 2 },
    },
    {
        id: 'session.archive',
        title: 'Archive Session',
        category: 'Session',
        description: 'Move the selected Session out of the sidebar and park its Terminals',
        nativeMenu: { menu: 'session', group: 0, order: 3 },
    },
    {
        id: 'session.detach',
        title: 'Detach Agent',
        category: 'Session',
        description:
            'Stop the selected Session’s Agent Terminals so another client can resume the same conversation',
        when: 'sessionHasLiveAgent',
        nativeMenu: { menu: 'session', group: 3, order: 0 },
    },
    {
        id: 'session.resume',
        title: 'Resume Agent',
        category: 'Session',
        description:
            'Relaunch the selected Session’s detached Agent Terminals and resume their conversations',
        when: 'sessionHasDetachedAgent',
        nativeMenu: { menu: 'session', group: 3, order: 1 },
    },
    {
        id: 'session.openPullRequest',
        title: 'Open Pull Request',
        category: 'Session',
        description: 'Open the selected Session’s pull request on GitHub in the browser',
        keywords: ['pr', 'github'],
        when: 'sessionHasPullRequest',
    },
    {
        id: 'session.selectNext',
        title: 'Select Next Session',
        category: 'Session',
        description: 'Select the next active Session',
        nativeMenu: { menu: 'session', group: 1, order: 1 },
    },
    {
        id: 'session.selectPrevious',
        title: 'Select Previous Session',
        category: 'Session',
        description: 'Select the previous active Session',
        nativeMenu: { menu: 'session', group: 1, order: 0 },
    },
    {
        id: 'session.switchMru',
        title: 'Switch to Recently Used Session',
        category: 'Session',
        description: 'Switch between active Sessions in recently used order',
    },
    {
        id: 'session.focusNextAttention',
        title: 'Go to Next Session Needing Attention',
        category: 'Session',
        description: 'Select the next Session with an event you have not opened yet',
        keywords: ['attention', 'unread', 'waiting', 'inbox'],
    },
    {
        id: 'session.navigateBack',
        title: 'Go Back',
        category: 'Session',
        description: 'Return to the Session you were viewing before this one',
        nativeMenu: { menu: 'session', group: 2, order: 0 },
    },
    {
        id: 'session.navigateForward',
        title: 'Go Forward',
        category: 'Session',
        description: 'Move forward again through the Sessions you stepped back from',
        nativeMenu: { menu: 'session', group: 2, order: 1 },
    },
    {
        id: 'session.searchContent',
        title: 'Search Session Content',
        category: 'Session',
        description: 'Find active and archived Sessions by user and assistant messages',
        keywords: ['conversation', 'transcript', 'history'],
        nativeMenu: { menu: 'session', group: 4, order: 1 },
    },
    {
        id: 'session.openArchived',
        title: 'Show Archived Sessions',
        category: 'Session',
        description: 'Open the Archived Sessions manager to restore or delete a parked Session',
        keywords: ['archive', 'archived', 'restore', 'unarchive'],
        nativeMenu: { menu: 'session', group: 4, order: 0 },
    },
    {
        id: 'agentActions.open',
        title: 'Run Agent Command or Skill…',
        category: 'Agent',
        description: 'Search Agent commands and skills for the active Agent Terminal',
        keywords: ['action', 'actions', 'command', 'commands', 'skill', 'skills', 'slash'],
    },
    {
        id: 'terminal.new',
        title: 'New Terminal',
        category: 'Terminal',
        description: 'Create a Terminal in the current Session',
        nativeMenu: { menu: 'terminal', group: 0, order: 0 },
    },
    {
        id: 'terminal.newInSplit',
        title: 'New Terminal in Split Pane',
        category: 'Terminal',
        description: 'Create a Terminal in a new pane to the right of the active pane',
    },
    {
        id: 'terminal.clear',
        title: 'Clear Terminal',
        category: 'Terminal',
        description: 'Clear the active Terminal view',
        nativeMenu: { menu: 'terminal', group: 0, order: 1 },
    },
    {
        id: 'terminal.copy',
        title: 'Copy Selection',
        category: 'Terminal',
        description: 'Copy the active Terminal selection to the clipboard',
        nativeMenu: { menu: 'terminal', group: 1, order: 0 },
    },
    {
        id: 'terminal.find',
        title: 'Find in Terminal',
        category: 'Terminal',
        description: 'Search the active Terminal buffer',
        nativeMenu: { menu: 'terminal', group: 1, order: 1 },
    },
    {
        id: 'terminal.openDetectedLink',
        title: 'Open Detected Link…',
        category: 'Terminal',
        description: 'Search and open links detected in the Terminal without using the pointer',
        nativeMenu: { menu: 'terminal', group: 1, order: 4 },
    },
    {
        id: 'terminal.previousCommand',
        title: 'Go to Previous Terminal Command',
        category: 'Terminal',
        description: 'Scroll the active Terminal to the previous command boundary',
        nativeMenu: { menu: 'terminal', group: 1, order: 2 },
    },
    {
        id: 'terminal.nextCommand',
        title: 'Go to Next Terminal Command',
        category: 'Terminal',
        description: 'Scroll the active Terminal to the next command boundary',
        nativeMenu: { menu: 'terminal', group: 1, order: 3 },
    },
    {
        id: 'workbench.action.terminal.sendSequence',
        title: 'Send Sequence',
        category: 'Terminal',
        description: 'Send configured text directly to the active Terminal',
        requiresArguments: true,
    },
    {
        id: 'terminal.restart',
        title: 'Restart Terminal',
        category: 'Terminal',
        description: 'Restart Shell or resume the active Agent Terminal',
        nativeMenu: { menu: 'terminal', group: 0, order: 2 },
    },
    {
        id: 'terminal.startNewAgentSession',
        title: 'Start New Agent Session',
        category: 'Terminal',
        description: 'Restart the active Agent Terminal without its current session binding',
        nativeMenu: { menu: 'terminal', group: 0, order: 3 },
    },
    {
        id: 'terminal.close',
        title: 'Close Terminal',
        category: 'Terminal',
        description: 'Close the active Terminal',
        nativeMenu: { menu: 'terminal', group: 0, order: 4 },
    },
    {
        id: 'workbench.closeActiveTab',
        title: 'Close Active Tab',
        category: 'View',
        description: 'Close the active Terminal or file tab',
        nativeMenu: { menu: 'window', group: 0, order: 0 },
    },
    {
        id: 'workbench.nextTab',
        title: 'Show Next Tab',
        category: 'View',
        description: 'Activate the next Terminal or file tab',
        nativeMenu: { menu: 'window', group: 1, order: 0 },
    },
    {
        id: 'workbench.previousTab',
        title: 'Show Previous Tab',
        category: 'View',
        description: 'Activate the previous Terminal or file tab',
        nativeMenu: { menu: 'window', group: 1, order: 1 },
    },
    {
        id: 'editor.save',
        title: 'Save File',
        category: 'Editor',
        description: 'Save the active file',
    },
    {
        id: 'editor.sendReferenceToTerminal',
        title: 'Send File Reference to Terminal',
        category: 'Editor',
        description:
            'Type the active file path and cursor line (`@path#L12`) into the most recently opened Terminal',
        keywords: ['mention', 'at', 'line', 'path', 'agent'],
    },
    {
        id: 'editor.addReviewComment',
        title: 'Add Review Comment',
        category: 'Editor',
        description: 'Annotate the selected lines in a Git diff',
        keywords: ['diff', 'comment', 'review', 'agent'],
    },
    {
        id: 'editor.openPreview',
        title: 'Open Preview',
        category: 'Editor',
        description: 'Show the active Markdown or SVG file as a rendered preview',
        keywords: ['markdown', 'md', 'render', 'svg', 'image', 'mermaid'],
    },
    {
        id: 'editor.openPreviewToSide',
        title: 'Open Preview to the Side',
        category: 'Editor',
        description: 'Show the active Markdown or SVG file as a rendered preview beside its source',
        keywords: ['markdown', 'md', 'render', 'svg', 'image', 'mermaid', 'split'],
    },
    {
        id: 'editor.openImportLink',
        title: 'Open Import Link',
        category: 'Editor',
        description: 'Open the file named by the import specifier under the editor cursor',
        keywords: ['definition', 'follow', 'go to', 'module', 'specifier'],
    },
    {
        id: 'workbench.splitLeft',
        title: 'Split Left',
        category: 'Workbench',
        description: 'Split the active tab into a new pane to the left',
    },
    {
        id: 'workbench.splitRight',
        title: 'Split Right',
        category: 'Workbench',
        description: 'Split the active tab into a new pane to the right',
    },
    {
        id: 'workbench.splitUp',
        title: 'Split Up',
        category: 'Workbench',
        description: 'Split the active tab into a new pane above',
    },
    {
        id: 'workbench.splitDown',
        title: 'Split Down',
        category: 'Workbench',
        description: 'Split the active tab into a new pane below',
    },
    {
        id: 'workbench.focusPaneLeft',
        title: 'Focus Pane to the Left',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane to the left of the current one',
    },
    {
        id: 'workbench.focusPaneRight',
        title: 'Focus Pane to the Right',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane to the right of the current one',
    },
    {
        id: 'workbench.focusPaneUp',
        title: 'Focus Pane Above',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane above the current one',
    },
    {
        id: 'workbench.focusPaneDown',
        title: 'Focus Pane Below',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane below the current one',
    },
    {
        id: 'workbench.moveActiveTerminalToNewSession',
        title: 'Move to New Session',
        category: 'Workbench',
        description: "Move the active Terminal into a new Session in the Terminal's Project",
    },
    {
        id: 'workbench.selectRoot',
        title: 'Select Workbench Root…',
        category: 'Workbench',
        description: 'Point Files, Editor, and Git at another Project root or linked worktree',
        keywords: ['root', 'worktree'],
    },
    ...filesCoreCommandDefinitions,
    /*
     * Declared here rather than in the Files contribution, and deliberately without `execution: 'viewCatalog'`: Search
     * Files opens a centered overlay that belongs to no view container. Leaving it catalog-owned would route it through
     * `didExecuteViewCatalogCommand`, which reveals a command's owning container before dispatching it — so every
     * `Cmd+Shift+F` would also pop the Files sidebar open behind the overlay. The id and its `cmd+shift+f` default are
     * unchanged, so the recorded keybinding migration from `inspector.searchFiles` still applies.
     */
    {
        id: 'secondarySidebar.searchFiles',
        title: 'Search Files',
        category: 'Secondary Side Bar',
        description: 'Search files in the selected Project',
        nativeMenu: { menu: 'view', group: 0, order: 0 },
    },
    {
        id: 'secondarySidebar.showGit',
        title: 'Show Git',
        category: 'Secondary Side Bar',
        description: 'Show Source Control in the Secondary Side Bar',
        execution: 'viewCatalog',
    },
    {
        id: 'secondarySidebar.showStatus',
        title: 'Show Status',
        category: 'Secondary Side Bar',
        description: 'Show Project Status in the Secondary Side Bar',
        execution: 'viewCatalog',
    },
    {
        id: 'secondarySidebar.toggle',
        title: 'Toggle Secondary Side Bar',
        category: 'Secondary Side Bar',
        description: 'Show or hide the Secondary Side Bar',
        nativeMenu: { menu: 'view', group: 0, order: 2 },
    },
    {
        id: 'panel.showLogs',
        title: 'Show Logs',
        category: 'Panel',
        description: 'Show Logs in the Panel',
    },
    {
        id: 'panel.showInfo',
        title: 'Show Info',
        category: 'Panel',
        description: 'Show Info in the Panel',
    },
    {
        id: 'panel.toggle',
        title: 'Toggle Panel',
        category: 'Panel',
        description: 'Show or hide the Panel',
        nativeMenu: { menu: 'view', group: 0, order: 3 },
    },
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
        id: 'settings.open',
        title: 'Open Settings',
        category: 'Preferences',
        description: 'Open Caxri Settings',
        nativeMenu: { menu: 'application', group: 0, order: 0 },
    },
    {
        id: 'settings.openSource',
        title: 'Open Settings (JSON)',
        category: 'Preferences',
        description: 'Open settings.jsonc in the Caxri source editor',
    },
    {
        id: 'settings.openKeybindings',
        title: 'Open Keyboard Shortcuts',
        category: 'Preferences',
        description: 'Edit Caxri keyboard shortcuts',
    },
    {
        id: 'settings.openNotifications',
        title: 'Open Notification Settings',
        category: 'Preferences',
        description: 'Manage notification preferences and restore muted reminders',
    },
    {
        id: 'settings.manageTrustedDomains',
        title: 'Manage Trusted Domains',
        category: 'Preferences',
        description: 'Review which external-link origins Caxri opens without confirmation',
    },
    {
        id: 'updates.check',
        title: 'Check for Updates',
        category: 'Preferences',
        description: 'Check for a newer Caxri release',
        nativeMenu: { menu: 'application', group: 0, order: 1 },
    },
    {
        id: 'pathBrowser.open',
        title: 'Open File by Path',
        category: 'View',
        description: 'Browse the selected Project and open a file',
        nativeMenu: { menu: 'view', group: 1, order: 0 },
    },
    {
        id: 'commandPalette.open',
        title: 'Open Command Palette',
        category: 'View',
        description: 'Search and run Caxri commands',
        nativeMenu: { menu: 'view', group: 1, order: 1 },
    },
    {
        id: 'processExplorer.open',
        title: 'Open Process Explorer',
        category: 'Help',
        description: 'Inspect Caxri process resource usage',
        nativeMenu: { menu: 'help', group: 0, order: 0 },
    },
    {
        id: 'developer.toggleScreencastMode',
        title: 'Toggle Screencast Mode',
        category: 'Developer',
        description: 'Show clicks and Caxri shortcuts for external screen recording',
    },
    {
        id: 'developer.reportBug',
        title: 'Report Bug to Agent',
        category: 'Help',
        description: 'Preview and send a privacy-safe local bug report to a running Agent',
        nativeMenu: { menu: 'help', group: 1, order: 0 },
    },
    {
        id: 'diagnostics.export',
        title: 'Export Diagnostics',
        category: 'Help',
        description: 'Export a privacy-safe diagnostics bundle',
        nativeMenu: { menu: 'help', group: 1, order: 1 },
    },
    {
        id: 'git.switchBranch',
        title: 'Switch Branch…',
        category: 'Git',
        description: "Check out another branch in the selected Session's repository",
        keywords: ['checkout', 'git'],
    },
];

export function getCommandDefinition(id: string): CommandDefinition {
    const definition = commandDefinitions.find((command) => command.id === id);
    if (!definition) throw new Error(`Unknown command: ${id}`);
    return definition;
}

/**
 * Returns command-backed native-menu groups in their declared presentation order.
 */
export function getNativeMenuCommandGroups(menu: NativeMenuId): CommandDefinition[][] {
    const placed = sortedCopy(
        commandDefinitions.filter((command) => command.nativeMenu?.menu === menu),
        (a, b) => {
            const aPlacement = a.nativeMenu;
            const bPlacement = b.nativeMenu;
            if (!aPlacement || !bPlacement) return 0;
            return aPlacement.group - bPlacement.group || aPlacement.order - bPlacement.order;
        },
    );
    const groups: CommandDefinition[][] = [];
    for (const command of placed) {
        const group = command.nativeMenu?.group;
        const previous = groups.at(-1);
        if (previous && previous[0]?.nativeMenu?.group === group) previous.push(command);
        else groups.push([command]);
    }
    return groups;
}

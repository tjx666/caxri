import { sortedCopy } from '@caxri/utils';

import { filesCoreCommandDefinitions } from '../registry/core-contributions.js';
import { agentChatCommandDefinitions } from './agent-chat-command-definitions.js';
import type { CommandId } from './commands.js';
import { gitCommandDefinitions } from './git-command-definitions.js';
import { sessionCommandDefinitions } from './session-command-definitions.js';
import { terminalCommandDefinitions } from './terminal-command-definitions.js';

/**
 * Context predicates the palette can evaluate against the current window and selected Session so commands only surface
 * when their target state is real. Kept as a small enum rather than a general when-clause expression because the
 * current catalog has only a handful of gated commands; a full evaluator is not warranted yet.
 *
 * - `localMachine`: the window's Server runs on this Mac. An SSH Host window hides commands that act on this machine's
 *   disk or OS, because Main refuses them there (see docs/adr/0014-ssh-remote-server.md).
 * - `sshHost`: the window belongs to an SSH Host.
 * - `openSessionStrip`: the Open Session tab strip is showing (two or more Open Sessions), so closing or switching its
 *   tabs means something. Palette only: the numbered shortcuts stay bound whether or not the strip is visible.
 * - `agentChatModels`, `agentChatPermissionModes`, `agentChatPlanMode`: the active tab is a Chat whose provider offers a
 *   model list, permission levels, or plan mode, so its composer can open that menu or flip that toggle.
 * - `agentChatSideChat`: the active tab is a Chat whose provider answers side questions, so its composer can open the
 *   side chat.
 * - `commanderHandOverAvailable` / `commanderTakeBackAvailable`: a local window whose selected Session the Agent
 *   Commander does not (or does) manage. Exactly one of the pair holds while a Session is selected, so the palette
 *   offers Hand Over or Take Back the way the Session row's menu does; with no Session selected, Hand Over still opens
 *   the empty picker.
 */
export type CommandWhen =
    | 'commanderHandOverAvailable'
    | 'commanderTakeBackAvailable'
    | 'sessionHasLiveAgent'
    | 'sessionHasDetachedAgent'
    | 'sessionHasPullRequest'
    | 'localMachine'
    | 'sshHost'
    | 'agentChatModels'
    | 'agentChatPermissionModes'
    | 'agentChatPlanMode'
    | 'agentChatSideChat'
    | 'openSessionStrip';

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
     * silent no-op: matching the row-menu's existing disabled affordance.
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
        when: 'localMachine',
    },
    {
        id: 'project.customizeIcon',
        title: 'Customize Project Icon…',
        category: 'Project',
        description: 'Choose a controlled icon and color for the selected Project',
        nativeMenu: { menu: 'project', group: 1, order: 1 },
    },
    ...sessionCommandDefinitions,
    {
        id: 'agentActions.open',
        title: 'Run Agent Command or Skill…',
        category: 'Agent',
        description: 'Search Agent commands and skills for the active Agent Terminal',
        keywords: ['action', 'actions', 'command', 'commands', 'skill', 'skills', 'slash'],
    },
    ...agentChatCommandDefinitions,
    ...terminalCommandDefinitions,
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
     * `didExecuteViewCatalogCommand`, which reveals a command's owning container before dispatching it, so every
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
        id: 'usage.open',
        title: 'Open Usage',
        category: 'View',
        description: 'Show token usage, estimated cost, and delivery stats for Caxri Sessions',
        keywords: ['usage', 'tokens', 'cost', 'spend', 'stats', 'statistics', 'ccusage'],
        nativeMenu: { menu: 'view', group: 3, order: 0 },
    },
    {
        id: 'benchmark.open',
        title: 'Open Benchmark',
        category: 'View',
        description:
            'Run one prompt across several Agents and models and compare quality, time, tokens, and cost',
        keywords: ['benchmark', 'compare', 'models', 'leaderboard', 'eval', 'arena', 'effort'],
        nativeMenu: { menu: 'view', group: 3, order: 1 },
        when: 'localMachine',
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
        id: 'shellCommand.install',
        title: "Install 'caxri' Command in PATH",
        category: 'Shell Command',
        description: 'Link the bundled caxri CLI into /usr/local/bin so any terminal can run it',
        keywords: ['cli', 'terminal', 'symlink'],
        when: 'localMachine',
    },
    {
        id: 'shellCommand.uninstall',
        title: "Uninstall 'caxri' Command from PATH",
        category: 'Shell Command',
        description: 'Remove the caxri link that points into a Caxri app bundle',
        keywords: ['cli', 'terminal', 'symlink'],
        when: 'localMachine',
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
        id: 'agentCommander.open',
        title: 'Open Agent Commander',
        category: 'View',
        description: 'Open the cross-Project Agent board beside the Commander Agent',
        nativeMenu: { menu: 'view', group: 1, order: 2 },
        when: 'localMachine',
    },
    {
        id: 'agentCommander.stop',
        title: 'Stop Agent Commander',
        category: 'View',
        description:
            'Stop the Agent Commander running in the background; opening it again resumes the same conversation',
        nativeMenu: { menu: 'view', group: 1, order: 3 },
        when: 'localMachine',
    },
    {
        id: 'agentCommander.handOver',
        title: 'Hand Over to Agent Commander…',
        category: 'View',
        description:
            'Pick Sessions, or Agent conversations started outside Caxri, for the Agent Commander to take over',
        when: 'commanderHandOverAvailable',
    },
    {
        id: 'agentCommander.takeBack',
        title: 'Take Back from Agent Commander',
        category: 'View',
        description:
            'End the Agent Commander’s management of the selected Session; its Agents keep running',
        when: 'commanderTakeBackAvailable',
    },
    /**
     * The cheatsheet leads the Help menu in its own group, the way VS Code's Help menu sets its "Keyboard Shortcuts
     * Reference" apart from the diagnostic tools below it. Unlike them it works in an SSH Host window too.
     */
    {
        id: 'help.showKeyboardShortcuts',
        title: 'Keyboard Shortcuts',
        category: 'Help',
        description: 'Show every keyboard shortcut, grouped by category',
        keywords: ['cheatsheet', 'keybindings', 'hotkeys'],
        nativeMenu: { menu: 'help', group: 0, order: 0 },
    },
    {
        id: 'processExplorer.open',
        title: 'Open Process Explorer',
        category: 'Help',
        description: 'Inspect Caxri process resource usage',
        nativeMenu: { menu: 'help', group: 1, order: 0 },
        when: 'localMachine',
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
        nativeMenu: { menu: 'help', group: 2, order: 0 },
        when: 'localMachine',
    },
    {
        id: 'diagnostics.export',
        title: 'Export Diagnostics',
        category: 'Help',
        description: 'Export a privacy-safe diagnostics bundle',
        nativeMenu: { menu: 'help', group: 2, order: 1 },
        when: 'localMachine',
    },
    {
        id: 'remote.connect',
        title: 'Connect to SSH Host…',
        category: 'SSH Host',
        description: 'Open a window whose Projects, Terminals, and Agents run on an SSH Host',
        keywords: ['ssh', 'remote', 'server'],
        nativeMenu: { menu: 'project', group: 2, order: 0 },
    },
    {
        id: 'remote.reconnect',
        title: 'Reconnect to SSH Host',
        category: 'SSH Host',
        description: "Reconnect this window to its SSH Host's Server",
        keywords: ['ssh', 'remote'],
        when: 'sshHost',
    },
    {
        id: 'remote.stopServer',
        title: 'Stop Server on SSH Host',
        category: 'SSH Host',
        description:
            'Stop the Server on this SSH Host, ending every Terminal and Agent running there',
        keywords: ['ssh', 'remote', 'shutdown'],
        when: 'sshHost',
    },
    ...gitCommandDefinitions,
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

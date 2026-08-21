import { z } from 'zod';

import type { BottomPanelCommandId } from './bottom-panel.js';
import type { InspectorCommandId } from './inspector.js';

/**
 * Catalog IDs for palette, shortcuts, native menus, and command-backed buttons. Inspector mode and Bottom Panel view
 * commands stay listed here so {@link commandIdSchema} remains a closed enum; a type check below fails if a registration
 * is added without an ID here.
 */
export const commandIds = [
    'project.create',
    'project.delete',
    'project.openInEditor',
    'project.customizeIcon',
    'session.create',
    'session.delete',
    'session.selectNext',
    'session.selectPrevious',
    'session.switchMru',
    'session.navigateBack',
    'session.navigateForward',
    'agentActions.open',
    'terminal.new',
    'terminal.clear',
    'terminal.copy',
    'terminal.find',
    'terminal.previousCommand',
    'terminal.nextCommand',
    'workbench.action.terminal.sendSequence',
    'terminal.restart',
    'terminal.startNewAgentSession',
    'terminal.close',
    'workbench.closeActiveTab',
    'workbench.nextTab',
    'workbench.previousTab',
    'editor.save',
    'editor.splitLeft',
    'editor.splitRight',
    'editor.splitUp',
    'editor.splitDown',
    'inspector.showFiles',
    'inspector.showGit',
    'inspector.showStatus',
    'inspector.searchFiles',
    'inspector.toggle',
    'bottomPanel.showLogs',
    'bottomPanel.showInfo',
    'bottomPanel.toggle',
    'sidebar.toggle',
    'settings.open',
    'settings.openSource',
    'settings.openKeybindings',
    'settings.manageTrustedDomains',
    'updates.check',
    'pathBrowser.open',
    'commandPalette.open',
    'processExplorer.open',
    'developer.toggleScreencastMode',
    'developer.reportBug',
    'diagnostics.export',
] as const;

export type CommandId = (typeof commandIds)[number];

/**
 * Keeps Inspector mode command IDs inside the catalog enum.
 */
export function inspectorCommandId(id: InspectorCommandId): CommandId {
    return id;
}

/**
 * Keeps Bottom Panel view command IDs inside the catalog enum.
 */
export function bottomPanelCommandId(id: BottomPanelCommandId): CommandId {
    return id;
}

export const commandIdSchema = z.enum(commandIds);

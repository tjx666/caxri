import { z } from 'zod';

import type { InspectorCommandId } from './inspector.js';

/**
 * Catalog IDs for palette, shortcuts, native menus, and command-backed buttons. Inspector mode
 * commands stay listed here so {@link commandIdSchema} remains a closed enum; a type check below
 * fails if a registration is added without an ID here.
 */
export const commandIds = [
    'project.create',
    'project.delete',
    'session.create',
    'session.delete',
    'session.selectNext',
    'session.selectPrevious',
    'terminal.new',
    'terminal.clear',
    'terminal.copy',
    'terminal.find',
    'terminal.previousCommand',
    'terminal.nextCommand',
    'terminal.restart',
    'terminal.startNewAgentSession',
    'terminal.close',
    'workbench.closeActiveTab',
    'workbench.nextTab',
    'workbench.previousTab',
    'editor.save',
    'inspector.showFiles',
    'inspector.showGit',
    'inspector.showStatus',
    'inspector.showInfo',
    'inspector.searchFiles',
    'inspector.toggle',
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
Keeps Inspector mode command IDs inside the catalog enum.
 */
export function inspectorCommandId(id: InspectorCommandId): CommandId {
    return id;
}

export const commandIdSchema = z.enum(commandIds);

import { describe, expect, it } from 'vitest';

import { commandDefinitions as sharedCommandDefinitions } from '@shared/commands';

import { commandDefinitions as registeredCommandDefinitions } from './definitions';
import { executeCommand, type CommandContext } from './execute';

function recordingContext(): { calls: string[]; context: CommandContext } {
    const calls: string[] = [];
    const record =
        (name: string) =>
        (...args: unknown[]): void => {
            calls.push(args.length > 0 ? `${name}(${String(args[0])})` : name);
        };
    return {
        calls,
        context: {
            project: { create: record('project.create'), removeSelected: record('project.remove') },
            session: {
                create: record('session.create'),
                deleteSelected: record('session.delete'),
                selectAdjacent: record('session.selectAdjacent'),
            },
            terminal: {
                create: record('terminal.create'),
                clearActive: record('terminal.clear'),
                restartActive: record('terminal.restart'),
                closeActive: record('terminal.close'),
            },
            editor: { saveActive: record('editor.save') },
            inspector: { setMode: record('inspector.setMode'), toggle: record('inspector.toggle') },
            dialogs: {
                openSettings: record('dialogs.openSettings'),
                openPalette: record('dialogs.openPalette'),
            },
            windows: { openProcessExplorer: record('windows.openProcessExplorer') },
            diagnostics: { export: record('diagnostics.export') },
        },
    };
}

describe('executeCommand', () => {
    it('dispatches every command in the shared catalog', () => {
        for (const definition of sharedCommandDefinitions) {
            const { calls, context } = recordingContext();
            executeCommand(definition.id, undefined, context);
            expect(calls, `no handler ran for ${definition.id}`).toHaveLength(1);
        }
    });

    it('registers exactly the ids the shared catalog declares, in both directions', () => {
        const sharedIds = new Set(sharedCommandDefinitions.map((definition) => definition.id));
        const registeredIds = new Set(
            registeredCommandDefinitions.map((definition) => definition.id),
        );

        for (const id of sharedIds)
            expect(registeredIds, `registry is missing ${id}`).toContain(id);
        for (const id of registeredIds)
            expect(sharedIds, `shared catalog is missing ${id}`).toContain(id);
    });

    it('keeps registry titles and categories in sync with the shared catalog', () => {
        for (const definition of registeredCommandDefinitions) {
            const shared = sharedCommandDefinitions.find((item) => item.id === definition.id);
            expect(shared, `shared catalog is missing ${definition.id}`).toBeDefined();
            expect(definition.title).toBe(shared?.title);
            expect(definition.category).toBe(shared?.category);
        }
    });

    it('maps the Session navigation commands to opposite directions', () => {
        const { calls, context } = recordingContext();
        executeCommand('session.selectNext', undefined, context);
        executeCommand('session.selectPrevious', undefined, context);

        expect(calls).toEqual(['session.selectAdjacent(1)', 'session.selectAdjacent(-1)']);
    });

    it('maps each Inspector command to its mode', () => {
        const { calls, context } = recordingContext();
        executeCommand('inspector.showFiles', undefined, context);
        executeCommand('inspector.showGit', undefined, context);
        executeCommand('inspector.showStatus', undefined, context);
        executeCommand('inspector.showInfo', undefined, context);

        expect(calls).toEqual([
            'inspector.setMode(files)',
            'inspector.setMode(git)',
            'inspector.setMode(status)',
            'inspector.setMode(info)',
        ]);
    });

    it('shows exactly one error toast for an unknown command instead of throwing', () => {
        const { calls, context } = recordingContext();

        expect(() => executeCommand('does.notExist', undefined, context)).not.toThrow();
        expect(calls).toEqual([]);
    });
});

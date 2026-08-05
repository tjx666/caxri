import { describe, expect, it } from 'vitest';

import { commandDefinitions } from '@shared/commands';

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
            inspector: { setMode: record('inspector.setMode') },
            dialogs: {
                openSettings: record('dialogs.openSettings'),
                openPalette: record('dialogs.openPalette'),
            },
            diagnostics: { export: record('diagnostics.export') },
        },
    };
}

describe('executeCommand', () => {
    it('dispatches every command in the shared catalog', () => {
        for (const definition of commandDefinitions) {
            const { calls, context } = recordingContext();
            executeCommand(definition.id, context);
            expect(calls, `no handler ran for ${definition.id}`).toHaveLength(1);
        }
    });

    it('maps the Session navigation commands to opposite directions', () => {
        const { calls, context } = recordingContext();
        executeCommand('session.selectNext', context);
        executeCommand('session.selectPrevious', context);

        expect(calls).toEqual(['session.selectAdjacent(1)', 'session.selectAdjacent(-1)']);
    });

    it('maps each Inspector command to its mode', () => {
        const { calls, context } = recordingContext();
        executeCommand('inspector.showFiles', context);
        executeCommand('inspector.showGit', context);
        executeCommand('inspector.showInfo', context);

        expect(calls).toEqual([
            'inspector.setMode(files)',
            'inspector.setMode(git)',
            'inspector.setMode(info)',
        ]);
    });

    it('ignores an unknown command instead of throwing', () => {
        const { calls, context } = recordingContext();
        executeCommand('does.notExist', context);

        expect(calls).toEqual([]);
    });
});

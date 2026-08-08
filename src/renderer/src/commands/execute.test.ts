import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commandDefinitions as sharedCommandDefinitions } from '@shared/commands';
import { inspectorModeRegistrations } from '@shared/inspector';

import { isEditableEventTarget } from '../lib/keybindings';
import { commandDefinitions as registeredCommandDefinitions } from './definitions';
import { executeCommand, runCommand, type CommandContext } from './execute';
import { registerCommand } from './registry';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so `Element`
 * and a real `document` do not exist; `isEditableEventTarget` itself is exercised elsewhere by the
 * keyboard-shortcut listener it backs. Here it is mocked so `runCommand`'s gate can be driven by a
 * plain boolean instead of a real DOM focus target.
 */
vi.mock('../lib/keybindings', () => ({ isEditableEventTarget: vi.fn() }));
const mockedIsEditableEventTarget = vi.mocked(isEditableEventTarget);

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
            workbench: { closeActiveTab: record('workbench.closeActiveTab') },
            editor: { saveActive: record('editor.save') },
            inspector: {
                searchFiles: record('inspector.searchFiles'),
                setMode: record('inspector.setMode'),
                toggle: record('inspector.toggle'),
            },
            sidebar: { toggle: record('sidebar.toggle') },
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
        for (const { commandId } of inspectorModeRegistrations)
            executeCommand(commandId, undefined, context);

        expect(calls).toEqual(
            inspectorModeRegistrations.map(({ mode }) => `inspector.setMode(${mode})`),
        );
    });

    it('shows exactly one error toast for an unknown command instead of throwing', () => {
        const { calls, context } = recordingContext();

        expect(() => executeCommand('does.notExist', undefined, context)).not.toThrow();
        expect(calls).toEqual([]);
    });
});

/**
 * Regression coverage for the DESIGN.md:121-123 editable-focus shortcut policy on the native menu
 * path (see `runCommand`'s JSDoc). `useCommandShortcuts` already covers the DOM keydown path by
 * gating before it ever calls `runCommand`; these tests cover the other caller — the native menu,
 * whose accelerator bypasses that DOM listener entirely.
 */
describe('runCommand editable-focus gate', () => {
    beforeEach(() => {
        /** `runCommand` reads `document.activeElement`; a minimal stub is enough since
         *  `isEditableEventTarget` itself is mocked above and never inspects it. */
        vi.stubGlobal('document', { activeElement: null });
        mockedIsEditableEventTarget.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('blocks a non-allowInEditable command fired by the menu accelerator while focus is editable', () => {
        const run = vi.fn();
        registerCommand({ id: 'test.gate.default', title: 'Gated', category: 'Test', run });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.default', undefined, { viaAccelerator: true });

        expect(run).not.toHaveBeenCalled();
    });

    it('still runs an allowInEditable command fired by the menu accelerator while focus is editable', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.gate.allowed',
            title: 'Allowed',
            category: 'Test',
            run,
            allowInEditable: true,
        });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.allowed', undefined, { viaAccelerator: true });

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('runs a non-allowInEditable command clicked on the menu (no accelerator) while focus is editable', () => {
        const run = vi.fn();
        registerCommand({ id: 'test.gate.clicked', title: 'Clicked', category: 'Test', run });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.clicked', undefined, { viaAccelerator: false });

        expect(run).toHaveBeenCalledTimes(1);
        expect(mockedIsEditableEventTarget).not.toHaveBeenCalled();
    });

    it('runs a non-allowInEditable command fired by a keyboard shortcut (no menu involvement) regardless of focus', () => {
        const run = vi.fn();
        registerCommand({ id: 'test.gate.shortcut', title: 'Shortcut', category: 'Test', run });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.shortcut');

        expect(run).toHaveBeenCalledTimes(1);
        expect(mockedIsEditableEventTarget).not.toHaveBeenCalled();
    });

    it('runs a non-allowInEditable command fired by the menu accelerator while focus is not editable', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.gate.notEditable',
            title: 'Not editable',
            category: 'Test',
            run,
        });
        mockedIsEditableEventTarget.mockReturnValue(false);

        runCommand('test.gate.notEditable', undefined, { viaAccelerator: true });

        expect(run).toHaveBeenCalledTimes(1);
    });
});

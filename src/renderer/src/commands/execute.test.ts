import type { CommandId } from '@shared/commands';
import { commandDefinitions as sharedCommandDefinitions } from '@shared/commands';
import { inspectorModeRegistrations } from '@shared/inspector';
import type { BootstrapState } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useFileSearchStore } from '../features/inspector/panels/files/file-search-state';
import { isEditableEventTarget } from '../lib/keybindings';
import { usePanelLayoutStore } from '../stores/panel-layout';
import { useWorkbenchStore } from '../stores/workbench';
import { commandDefinitions as registeredCommandDefinitions } from './definitions';
import type { CommandContext } from './execute';
import { executeCommand, isCommandAvailable, runCommand } from './execute';
import { registerCommand } from './registry';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so `Element` and a real
 * `document` do not exist; `isEditableEventTarget` itself is exercised elsewhere by the keyboard-shortcut listener it
 * backs. Here it is mocked so `runCommand`'s gate can be driven by a plain boolean instead of a real DOM focus target.
 */
vi.mock('../lib/keybindings', () => ({ isEditableEventTarget: vi.fn() }));
const mockedIsEditableEventTarget = vi.mocked(isEditableEventTarget);

function recordingContext(): { calls: string[]; context: CommandContext } {
    const calls: string[] = [];
    const record =
        (name: string) =>
        (...arguments_: unknown[]): void => {
            calls.push(arguments_.length > 0 ? `${name}(${String(arguments_[0])})` : name);
        };
    return {
        calls,
        context: {
            agentActions: {
                canOpen: () => true,
                open: record('agentActions.open'),
            },
            project: {
                create: record('project.create'),
                customizeIcon: record('project.customizeIcon'),
                openInExternalEditor: record('project.openInEditor'),
                removeSelected: record('project.remove'),
            },
            session: {
                canNavigateHistory: () => true,
                create: record('session.create'),
                deleteSelected: record('session.delete'),
                navigateHistory: record('session.navigateHistory'),
                selectAdjacent: record('session.selectAdjacent'),
                switchMru: record('session.switchMru'),
            },
            terminal: {
                create: record('terminal.create'),
                clearActive: record('terminal.clear'),
                copySelection: record('terminal.copySelection'),
                findActive: record('terminal.find'),
                hasActive: () => true,
                hasSelection: () => true,
                navigateCommand: record('terminal.navigateCommand'),
                sendSequence: record('terminal.sendSequence'),
                restartActive: record('terminal.restart'),
                startNewAgentSession: record('terminal.startNewAgentSession'),
                closeActive: record('terminal.close'),
            },
            workbench: {
                closeActiveTab: record('workbench.closeActiveTab'),
                cycleTab: record('workbench.cycleTab'),
                canSplitActive: () => true,
                splitActive: record('workbench.splitActive'),
            },
            editor: { saveActive: record('editor.save') },
            inspector: {
                searchFiles: record('inspector.searchFiles'),
                activateMode: record('inspector.activateMode'),
                toggle: record('inspector.toggle'),
            },
            bottomPanel: {
                activateView: record('bottomPanel.activateView'),
                toggle: record('bottomPanel.toggle'),
            },
            sidebar: { toggle: record('sidebar.toggle') },
            dialogs: {
                openSettings: record('dialogs.openSettings'),
                openPalette: record('dialogs.openPalette'),
                openPathBrowser: record('dialogs.openPathBrowser'),
            },
            windows: { openProcessExplorer: record('windows.openProcessExplorer') },
            developer: {
                reportBug: record('developer.reportBug'),
                toggleScreencastMode: record('developer.toggleScreencastMode'),
            },
            diagnostics: { export: record('diagnostics.export') },
            updates: { check: record('updates.check') },
        },
    };
}

describe('executeCommand', () => {
    it('dispatches every command in the shared catalog', () => {
        for (const definition of sharedCommandDefinitions) {
            const { calls, context } = recordingContext();
            executeCommand(
                definition.id,
                definition.requiresArguments ? { text: 'configured argument' } : undefined,
                context,
            );
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

    it('runs Agent Actions only when the active Terminal is a running Agent', () => {
        const { calls, context } = recordingContext();
        context.agentActions.canOpen = () => false;
        executeCommand('agentActions.open', undefined, context);
        expect(calls).toEqual([]);

        context.agentActions.canOpen = () => true;
        executeCommand('agentActions.open', undefined, context);
        expect(calls).toEqual(['agentActions.open']);
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

    it('passes the shortcut lifecycle metadata to Session MRU switching', () => {
        const { context } = recordingContext();
        const switchMru = vi.fn();
        context.session.switchMru = switchMru;
        executeCommand(
            'session.switchMru',
            {
                shortcut: {
                    heldModifiers: ['Control', 'Alt'],
                    triggerCode: 'Tab',
                },
            },
            context,
        );

        expect(switchMru).toHaveBeenCalledWith({
            heldModifiers: ['Control', 'Alt'],
            triggerCode: 'Tab',
        });
    });

    it('keeps Terminal Find contextual so Monaco can own the same shortcut in an editor', () => {
        const { calls, context } = recordingContext();
        context.terminal.hasActive = () => false;

        expect(isCommandAvailable('terminal.find', context)).toBe(false);
        executeCommand('terminal.find', undefined, context);

        expect(calls).toEqual([]);
    });

    /**
     * `terminal.copy` binds `Cmd+C`. Without a Terminal selection the command must decline so the chord falls through
     * to the native copy an input or Monaco would otherwise handle.
     */
    it('keeps Terminal Copy contextual on the presence of a selection', () => {
        const { calls, context } = recordingContext();
        context.terminal.hasSelection = () => false;

        expect(isCommandAvailable('terminal.copy', context)).toBe(false);
        executeCommand('terminal.copy', undefined, context);

        expect(calls).toEqual([]);
    });

    it('maps the tab cycling commands to opposite directions', () => {
        const { calls, context } = recordingContext();
        executeCommand('workbench.nextTab', undefined, context);
        executeCommand('workbench.previousTab', undefined, context);

        expect(calls).toEqual(['workbench.cycleTab(1)', 'workbench.cycleTab(-1)']);
    });

    it('sends an exact configured control sequence to the active Terminal', () => {
        const { context } = recordingContext();
        const sendSequence = vi.fn();
        context.terminal.sendSequence = sendSequence;

        executeCommand('workbench.action.terminal.sendSequence', { text: '\u{1B}[1;3B' }, context);

        expect(sendSequence).toHaveBeenCalledWith('\u{1B}[1;3B');
    });

    it('maps each split command to the side its new pane takes', () => {
        const { calls, context } = recordingContext();
        executeCommand('workbench.splitLeft', undefined, context);
        executeCommand('workbench.splitRight', undefined, context);
        executeCommand('workbench.splitUp', undefined, context);
        executeCommand('workbench.splitDown', undefined, context);

        expect(calls).toEqual([
            'workbench.splitActive(left)',
            'workbench.splitActive(right)',
            'workbench.splitActive(up)',
            'workbench.splitActive(down)',
        ]);
    });

    /**
     * The active pane must hold more than one tab; otherwise the split commands are no-ops so the palette and native
     * menu never invoke `splitActive` against a pane that would be left empty.
     */
    it('keeps split commands contextual on a pane that can actually be split', () => {
        const { calls, context } = recordingContext();
        context.workbench.canSplitActive = () => false;

        expect(isCommandAvailable('workbench.splitLeft', context)).toBe(false);
        executeCommand('workbench.splitLeft', undefined, context);

        expect(calls).toEqual([]);
    });

    it('maps each Inspector command to its mode', () => {
        const { calls, context } = recordingContext();
        for (const { commandId } of inspectorModeRegistrations)
            executeCommand(commandId, undefined, context);

        expect(calls).toEqual(
            inspectorModeRegistrations.map(({ mode }) => `inspector.activateMode(${mode})`),
        );
    });

    describe('Inspector activation', () => {
        beforeEach(() => {
            vi.stubGlobal('window', {
                caxri: {
                    negotiate: vi.fn(),
                    onEvent: vi.fn(),
                    request: vi.fn().mockResolvedValue(undefined),
                },
            });
            useWorkbenchStore.setState({
                bootstrap: {
                    selectedSessionId: 'session-1',
                    sessions: [
                        {
                            id: 'session-1',
                            projectId: 'project-1',
                            workbenchProjectId: 'project-1',
                        },
                    ],
                    sessionStates: [
                        {
                            sessionId: 'session-1',
                            workbenchProjectId: 'project-1',
                            openTabs: [],
                            inspectorMode: 'files',
                            layout: {},
                        },
                    ],
                } as unknown as BootstrapState,
                attachEpoch: 0,
            });
            useFileSearchStore.setState({ activeSessionId: undefined, focusRevision: 0 });
        });

        afterEach(() => {
            useWorkbenchStore.setState({ bootstrap: undefined, attachEpoch: 0 });
            useFileSearchStore.setState({ activeSessionId: undefined, focusRevision: 0 });
            vi.unstubAllGlobals();
        });

        it.each(inspectorModeRegistrations)(
            'reveals the Inspector and selects $mode for $commandId',
            ({ commandId, mode }) => {
                usePanelLayoutStore.setState({ inspectorVisible: false });

                executeCommand(commandId);

                expect(usePanelLayoutStore.getState().inspectorVisible).toBe(true);
                expect(
                    useWorkbenchStore.getState().bootstrap?.sessionStates[0]?.inspectorMode,
                ).toBe(mode);
            },
        );

        it('does not re-persist the panel layout while switching an already visible Inspector', () => {
            usePanelLayoutStore.setState({ inspectorVisible: true });
            const setInspectorVisible = vi.spyOn(
                usePanelLayoutStore.getState(),
                'setInspectorVisible',
            );

            for (const { commandId } of inspectorModeRegistrations) executeCommand(commandId);

            expect(setInspectorVisible).not.toHaveBeenCalled();
            expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0]?.inspectorMode).toBe(
                inspectorModeRegistrations.at(-1)?.mode,
            );
        });

        it('routes Search Files through the same Inspector activation before requesting focus', () => {
            usePanelLayoutStore.setState({ inspectorVisible: false });

            executeCommand('inspector.searchFiles');

            expect(usePanelLayoutStore.getState().inspectorVisible).toBe(true);
            expect(useWorkbenchStore.getState().bootstrap?.sessionStates[0]?.inspectorMode).toBe(
                'files',
            );
            expect(useFileSearchStore.getState()).toMatchObject({
                activeSessionId: 'session-1',
                focusRevision: 1,
            });
        });
    });

    it('deep-links the Settings source and Trusted Domains commands', () => {
        const { calls, context } = recordingContext();

        executeCommand('settings.open', undefined, context);
        executeCommand('settings.openSource', undefined, context);
        executeCommand('settings.manageTrustedDomains', undefined, context);

        expect(calls).toEqual([
            'dialogs.openSettings',
            'dialogs.openSettings(source)',
            'dialogs.openSettings(trusted-domains)',
        ]);
    });

    it('shows exactly one error toast for an unknown command instead of throwing', () => {
        const { calls, context } = recordingContext();

        expect(() =>
            executeCommand('does.notExist' as CommandId, undefined, context),
        ).not.toThrow();
        expect(calls).toEqual([]);
    });
});

/**
 * Regression coverage for the DESIGN.md:121-123 editable-focus shortcut policy on the native menu path (see
 * `runCommand`'s JSDoc). `useCommandShortcuts` already covers the DOM keydown path by gating before it ever calls
 * `runCommand`; these tests cover the other caller — the native menu, whose accelerator bypasses that DOM listener
 * entirely.
 */
describe('runCommand editable-focus gate', () => {
    beforeEach(() => {
        /**
         * `runCommand` reads `document.activeElement`; a minimal stub is enough since `isEditableEventTarget` itself is
         * mocked above and never inspects it.
         */
        vi.stubGlobal('document', { activeElement: null });
        mockedIsEditableEventTarget.mockReset();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('blocks a non-allowInEditable command fired by the menu accelerator while focus is editable', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.gate.default' as CommandId,
            title: 'Gated',
            category: 'Test',
            run,
        });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.default' as CommandId, undefined, { viaAccelerator: true });

        expect(run).not.toHaveBeenCalled();
    });

    it('still runs an allowInEditable command fired by the menu accelerator while focus is editable', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.gate.allowed' as CommandId,
            title: 'Allowed',
            category: 'Test',
            run,
            allowInEditable: true,
        });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.allowed' as CommandId, undefined, { viaAccelerator: true });

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('runs a non-allowInEditable command clicked on the menu (no accelerator) while focus is editable', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.gate.clicked' as CommandId,
            title: 'Clicked',
            category: 'Test',
            run,
        });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.clicked' as CommandId, undefined, { viaAccelerator: false });

        expect(run).toHaveBeenCalledTimes(1);
        expect(mockedIsEditableEventTarget).not.toHaveBeenCalled();
    });

    it('runs a non-allowInEditable command fired by a keyboard shortcut (no menu involvement) regardless of focus', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.gate.shortcut' as CommandId,
            title: 'Shortcut',
            category: 'Test',
            run,
        });
        mockedIsEditableEventTarget.mockReturnValue(true);

        runCommand('test.gate.shortcut' as CommandId);

        expect(run).toHaveBeenCalledTimes(1);
        expect(mockedIsEditableEventTarget).not.toHaveBeenCalled();
    });

    it('runs a non-allowInEditable command fired by the menu accelerator while focus is not editable', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.gate.notEditable' as CommandId,
            title: 'Not editable',
            category: 'Test',
            run,
        });
        mockedIsEditableEventTarget.mockReturnValue(false);

        runCommand('test.gate.notEditable' as CommandId, undefined, { viaAccelerator: true });

        expect(run).toHaveBeenCalledTimes(1);
    });
});

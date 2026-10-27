import type { CommandId } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isEditableEventTarget } from '../lib/keybindings';
import { useDialogStore } from '../stores/dialogs';
import { commandDefinitions as registeredCommandDefinitions } from './definitions';
import { runCommand } from './execute';
import { registerCommand } from './registry';

/**
 * The suite runs under Vitest's `node` environment (no jsdom, see `vitest.config.ts`), so `Element` and a real
 * `document` do not exist; `isEditableEventTarget` itself is exercised elsewhere by the keyboard-shortcut listener it
 * backs. Here it is mocked so `runCommand`'s gate can be driven by a plain boolean instead of a real DOM focus target.
 */
vi.mock('../lib/keybindings', () => ({ isEditableEventTarget: vi.fn() }));

/**
 * `execute.ts` imports `git-review-navigation-commands.ts`, which reaches `git-review-comment-binding.ts` for its
 * mounted-editor registry; that module imports Monaco, which needs a real `window` unavailable under this suite's
 * `node` environment. This test drives `context.git.*` through the local `record`-based stand-ins below rather than the
 * real navigation commands, so the binding registry itself is stubbed out instead of loaded.
 */
vi.mock('../features/editor/git-review-comment-binding', () => ({
    listBoundGitReviewCommentEditors: () => new Set(),
}));
const mockedIsEditableEventTarget = vi.mocked(isEditableEventTarget);

/**
 * Regression coverage for the DESIGN.md Interaction rules editable-focus shortcut policy on the native menu path (see
 * `runCommand`'s JSDoc). `useCommandShortcuts` already covers the DOM keydown path by gating before it ever calls
 * `runCommand`; these tests cover the other caller: the native menu, whose accelerator bypasses that DOM listener
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

/**
 * A modal dialog blocks commands that would change Workbench state behind it. Window zoom changes the window, dialog
 * included, so it still runs; Caxri Bot sends its zoom here while a Workbench dialog it cannot see is open.
 */
describe('runCommand modal gate', () => {
    beforeEach(() => {
        vi.stubGlobal('document', { activeElement: null });
        mockedIsEditableEventTarget.mockReset();
        useDialogStore.getState().registerModal('report-bug');
    });

    afterEach(() => {
        useDialogStore.getState().unregisterModal('report-bug');
        vi.unstubAllGlobals();
    });

    it('runs a command allowed behind a modal and blocks any other', () => {
        const allowed = vi.fn();
        const blocked = vi.fn();
        registerCommand({
            id: 'test.modal.allowed' as CommandId,
            title: 'Allowed',
            category: 'Test',
            run: allowed,
            allowBehindModal: true,
        });
        registerCommand({
            id: 'test.modal.blocked' as CommandId,
            title: 'Blocked',
            category: 'Test',
            run: blocked,
        });

        runCommand('test.modal.allowed' as CommandId, undefined, { viaAccelerator: true });
        runCommand('test.modal.blocked' as CommandId, undefined, { viaAccelerator: true });

        expect(allowed).toHaveBeenCalledOnce();
        expect(blocked).not.toHaveBeenCalled();
    });

    it('allows only window zoom behind a modal', () => {
        expect(
            registeredCommandDefinitions
                .filter((definition) => definition.allowBehindModal)
                .map((definition) => definition.id),
        ).toEqual(['view.zoomIn', 'view.zoomOut', 'view.resetZoom']);
    });
});

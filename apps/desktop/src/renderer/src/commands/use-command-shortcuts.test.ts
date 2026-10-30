import type { BootstrapState, CommandId, Keybinding } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDialogStore } from '../stores/dialogs';
import { useWorkbenchStore } from '../stores/workbench';
import { registerCommand } from './registry';
import { createGlobalShortcutDispatchState, dispatchGlobalKeydown } from './use-command-shortcuts';

/**
 * This suite imports `./execute` (via `./use-command-shortcuts`), which imports `review-navigation-commands.ts`, which
 * reaches `review-comment-binding.ts` for its mounted-editor registry; that module imports Monaco, which needs a real
 * `window` unavailable under this suite's `node` environment (see `vitest.config.ts`). The binding registry itself is
 * stubbed out rather than loaded, matching the same fix in `execute.test.ts` and `execute-diagnostics.test.ts`.
 */
vi.mock('../features/editor/git/review-comment-binding', () => ({
    listBoundGitReviewCommentEditors: () => new Set(),
}));
/**
 * Opening Project search first reads the focused selection, which needs the `document` this `node` suite lacks.
 */
vi.mock('../lib/focused-text-selection', () => ({ focusedTextSelection: () => '' }));

/**
 * Issue #1093: a global shortcut typed during the gap between a picker deciding to close and its modal registration
 * actually clearing reads `isModalOpen()` as stale-true and is silently swallowed: even the shortcut that would reopen
 * the very picker that just closed. `registerModal`/`unregisterModal` are driven by `useModalRegistration`'s effect in
 * real usage, which this suite's `node` environment cannot render (no `window`/`document`, see the module comment
 * above); these tests instead hold the registry in that exact intermediate state directly, which is the "hold the focus
 * handoff open" reproduction the issue calls for, without depending on React's effect scheduling.
 */
describe('dispatchGlobalKeydown', () => {
    const projectSearchShortcut: Keybinding = {
        key: 'cmd+shift+f',
        command: 'secondarySidebar.searchFiles',
    };

    function projectSearchKeydownEvent(): {
        event: KeyboardEvent;
        preventDefault: ReturnType<typeof vi.fn>;
    } {
        const preventDefault = vi.fn();
        const event = {
            altKey: false,
            code: '',
            ctrlKey: false,
            isComposing: false,
            key: 'f',
            metaKey: true,
            preventDefault,
            shiftKey: true,
            stopPropagation: vi.fn(),
            target: null,
        } as unknown as KeyboardEvent;
        return { event, preventDefault };
    }

    afterEach(() => {
        useWorkbenchStore.setState({ bootstrap: undefined });
        for (const id of useDialogStore.getState().openModalIds)
            useDialogStore.getState().unregisterModal(id);
        useDialogStore.getState().setProjectSearchOpen(false);
    });

    /**
     * `secondarySidebar.searchFiles` has no `when` gate and opts into `allowInEditable`, so nothing about the resolved
     * binding itself would explain a no-op; only the modal gate can.
     */
    it('drops the resolved Cmd+Shift+F shortcut while a picker is still registered as an open modal', () => {
        useWorkbenchStore.setState({
            bootstrap: { keybindings: [projectSearchShortcut] } as unknown as BootstrapState,
        });
        // Simulate the exact gap `useModalRegistration` can otherwise leave open: the app already decided to close
        // Project Search (its own `open` boolean is false), but the registry has not been told yet.
        useDialogStore.getState().registerModal('project-search-picker');

        const { event, preventDefault } = projectSearchKeydownEvent();
        dispatchGlobalKeydown(createGlobalShortcutDispatchState(), event);

        // The keystroke is still consumed (it must not leak into whatever the window falls back to); it just does
        // nothing, matching the reported symptom exactly: the overlay never reopens, and a retry works.
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(useDialogStore.getState().projectSearchOpen).toBe(false);
    });

    it('runs a shortcut for a command allowed behind a modal, such as window zoom', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.shortcut.behindModal' as CommandId,
            title: 'Behind modal',
            category: 'Test',
            run,
            allowBehindModal: true,
        });
        useWorkbenchStore.setState({
            bootstrap: {
                keybindings: [{ key: 'cmd+shift+f', command: 'test.shortcut.behindModal' }],
            } as unknown as BootstrapState,
        });
        useDialogStore.getState().registerModal('report-bug');

        const { event, preventDefault } = projectSearchKeydownEvent();
        dispatchGlobalKeydown(createGlobalShortcutDispatchState(), event);

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledOnce();
    });

    it('runs a command that ignores repeats once per press, consuming the held key', () => {
        const run = vi.fn();
        registerCommand({
            id: 'test.shortcut.once' as CommandId,
            title: 'Once',
            category: 'Test',
            run,
            ignoresRepeat: true,
        });
        useWorkbenchStore.setState({
            bootstrap: {
                keybindings: [{ key: 'cmd+shift+f', command: 'test.shortcut.once' }],
            } as unknown as BootstrapState,
        });
        const state = createGlobalShortcutDispatchState();
        const first = projectSearchKeydownEvent();
        dispatchGlobalKeydown(state, first.event);
        const held = projectSearchKeydownEvent();
        Object.assign(held.event, { repeat: true });
        dispatchGlobalKeydown(state, held.event);

        expect(run).toHaveBeenCalledOnce();
        expect(held.preventDefault).toHaveBeenCalledOnce();
    });

    it('passes a key whose default command cannot run on to a later binding for it, and leaves it alone without one', () => {
        const unavailable = vi.fn();
        const later = vi.fn();
        registerCommand({
            id: 'test.shortcut.unavailable' as CommandId,
            title: 'Unavailable',
            category: 'Test',
            run: unavailable,
            when: () => false,
        });
        registerCommand({
            id: 'test.shortcut.later' as CommandId,
            title: 'Later',
            category: 'Test',
            run: later,
        });
        const defaultBinding = { key: 'cmd+shift+f', command: 'test.shortcut.unavailable' };
        useWorkbenchStore.setState({
            bootstrap: {
                keybindings: [
                    defaultBinding,
                    { key: 'cmd+shift+f', command: 'test.shortcut.later' },
                ],
            } as unknown as BootstrapState,
        });
        const withLater = projectSearchKeydownEvent();
        dispatchGlobalKeydown(createGlobalShortcutDispatchState(), withLater.event);
        expect(later).toHaveBeenCalledOnce();
        expect(unavailable).not.toHaveBeenCalled();

        useWorkbenchStore.setState({
            bootstrap: { keybindings: [defaultBinding] } as unknown as BootstrapState,
        });
        const alone = projectSearchKeydownEvent();
        dispatchGlobalKeydown(createGlobalShortcutDispatchState(), alone.event);
        expect(alone.preventDefault).not.toHaveBeenCalled();
        expect(unavailable).not.toHaveBeenCalled();
    });

    it('honors the same shortcut once the handoff has settled and the registration is clear', async () => {
        useWorkbenchStore.setState({
            bootstrap: { keybindings: [projectSearchShortcut] } as unknown as BootstrapState,
        });

        const { event, preventDefault } = projectSearchKeydownEvent();
        dispatchGlobalKeydown(createGlobalShortcutDispatchState(), event);

        expect(preventDefault).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(useDialogStore.getState().projectSearchOpen).toBe(true));
    });
});

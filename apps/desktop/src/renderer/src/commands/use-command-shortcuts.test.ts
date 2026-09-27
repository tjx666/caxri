import type { BootstrapState, Keybinding } from '@caxri/protocol';
import { buildChordLeadingChords, defaultKeybindings } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildShortcutMap } from '../lib/keybindings';
import { useDialogStore } from '../stores/dialogs';
import { useWorkbenchStore } from '../stores/workbench';
import type { KeystrokeOutcome, PendingChord } from './use-command-shortcuts';
import {
    createGlobalShortcutDispatchState,
    dispatchGlobalKeydown,
    resolveKeydownBinding,
    resolveKeystroke,
} from './use-command-shortcuts';

/**
 * This suite imports `./execute` (via `./use-command-shortcuts`), which imports `git-review-navigation-commands.ts`,
 * which reaches `git-review-comment-binding.ts` for its mounted-editor registry; that module imports Monaco, which
 * needs a real `window` unavailable under this suite's `node` environment (see `vitest.config.ts`). The binding
 * registry itself is stubbed out rather than loaded, matching the same fix in `execute.test.ts` and
 * `execute-diagnostics.test.ts`.
 */
vi.mock('../features/editor/git-review-comment-binding', () => ({
    listBoundGitReviewCommentEditors: () => new Set(),
}));

function shiftedBackquoteEvent(): KeyboardEvent {
    return {
        altKey: false,
        code: 'Backquote',
        ctrlKey: false,
        key: '~',
        metaKey: true,
        shiftKey: true,
    } as KeyboardEvent;
}

function keyEvent(key: string, modifiers: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return {
        altKey: false,
        code: '',
        ctrlKey: false,
        key,
        metaKey: false,
        shiftKey: false,
        ...modifiers,
    } as KeyboardEvent;
}

describe('resolveKeydownBinding', () => {
    it('preserves an exact custom Cmd+Shift+Tilde binding ahead of Session MRU fallback', () => {
        const custom = { key: 'cmd+shift+~', command: 'terminal.new' } as const;
        const shortcutMap = buildShortcutMap([
            custom,
            { key: 'cmd+`', command: 'session.switchMru' },
        ]);

        expect(
            resolveKeydownBinding(shortcutMap, shiftedBackquoteEvent(), {
                terminalFocus: false,
            }),
        ).toEqual(custom);
    });

    it('uses the unshifted physical Backquote binding only for reverse Session MRU', () => {
        const sessionMru = { key: 'cmd+`', command: 'session.switchMru' } as const;
        const shortcutMap = buildShortcutMap([sessionMru]);

        expect(
            resolveKeydownBinding(shortcutMap, shiftedBackquoteEvent(), {
                terminalFocus: false,
            }),
        ).toEqual(sessionMru);
    });

    /**
     * Guards the whole shipped default set rather than one binding: a new `cmd+shift+\`` default looks reachable in the
     * catalog and is dead on arrival, because the fallback above claims that physical stroke for reverse MRU before the
     * new command can ever see it. `session.focusNextAttention` was written that way first.
     */
    it('leaves Cmd+Shift+Backquote to reverse Session MRU across the shipped defaults', () => {
        const binding = resolveKeydownBinding(
            buildShortcutMap(defaultKeybindings),
            shiftedBackquoteEvent(),
            { terminalFocus: false },
        );

        expect(binding?.command).toBe('session.switchMru');
    });

    /**
     * `Cmd+Shift+K` is Monaco's Delete Line. Terminal Clear opts into `allowInEditable`, so an ungated default would be
     * dispatched straight out of a focused editor and the line would never be deleted — the gate is the only thing
     * keeping the two commands on one chord.
     */
    it('leaves Cmd+Shift+K to the editor unless a Terminal owns focus', () => {
        const shortcutMap = buildShortcutMap(defaultKeybindings);
        const event = keyEvent('k', { metaKey: true, shiftKey: true });

        expect(resolveKeydownBinding(shortcutMap, event, { terminalFocus: false })).toBeUndefined();
        expect(resolveKeydownBinding(shortcutMap, event, { terminalFocus: true })?.command).toBe(
            'terminal.clear',
        );
    });
});

describe('resolveKeystroke', () => {
    const keybindings: Keybinding[] = [
        { key: 'cmd+1', command: 'secondarySidebar.showFiles' },
        { key: 'cmd+shift+k', command: 'terminal.clear' },
        { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
    ];
    const shortcutMap = buildShortcutMap(keybindings);
    const leadingChords = buildChordLeadingChords(keybindings);

    function step(
        event: KeyboardEvent,
        {
            editorFocus = false,
            pending,
            terminalFocus = false,
        }: { editorFocus?: boolean; pending?: PendingChord; terminalFocus?: boolean } = {},
    ): KeystrokeOutcome {
        return resolveKeystroke({
            editorFocus,
            event,
            leadingChords,
            pending,
            shortcutMap,
            terminalFocus,
        });
    }

    const commandK = keyEvent('k', { metaKey: true });

    it('arms the pending chord and consumes it outside the editor', () => {
        expect(step(commandK)).toEqual({
            kind: 'armChord',
            leadingChord: 'cmd+k',
            yieldToEditor: false,
        });
    });

    it('releases the leading chord to Monaco when the editor owns focus', () => {
        expect(step(commandK, { editorFocus: true })).toEqual({
            kind: 'armChord',
            leadingChord: 'cmd+k',
            yieldToEditor: true,
        });
    });

    /**
     * The collision this mechanism exists to remove: `Cmd+K Cmd+1` folds to level one instead of switching the
     * Secondary Side Bar, even though `cmd+1` is a live app binding.
     */
    it('leaves the continuation of an editor-owned sequence untouched', () => {
        expect(
            step(keyEvent('1', { metaKey: true }), {
                editorFocus: true,
                pending: { leadingChord: 'cmd+k', yieldToEditor: true },
            }),
        ).toEqual({ kind: 'yieldChordContinuation' });
    });

    it('resolves a Caxri-owned sequence from the pending chord and the current one', () => {
        expect(
            step(keyEvent('s', { metaKey: true }), {
                pending: { leadingChord: 'cmd+k', yieldToEditor: false },
            }),
        ).toEqual({
            kind: 'dispatch',
            binding: { key: 'cmd+k cmd+s', command: 'settings.openKeybindings' },
        });
    });

    /**
     * A half-typed sequence must not leak its second key into a Terminal or an input, so an unmatched continuation is
     * swallowed rather than dispatched as a standalone shortcut.
     */
    it('cancels and swallows a Caxri-owned sequence that matches nothing', () => {
        expect(
            step(keyEvent('1', { metaKey: true }), {
                pending: { leadingChord: 'cmd+k', yieldToEditor: false },
            }),
        ).toEqual({ kind: 'cancelChord' });
    });

    /**
     * A pending chord has no visible affordance, so an accidental `Cmd+K` over a dialog must not also eat the Escape
     * the user presses to close it. Escape ends the sequence and still reaches the dialog's own handler.
     */
    it('releases Escape instead of swallowing it as a failed continuation', () => {
        expect(
            step(keyEvent('Escape'), { pending: { leadingChord: 'cmd+k', yieldToEditor: false } }),
        ).toEqual({ kind: 'ignore' });
    });

    it('still resolves the standalone binding whose chord a sequence reuses as a continuation', () => {
        expect(step(keyEvent('1', { metaKey: true }))).toEqual({
            kind: 'dispatch',
            binding: { key: 'cmd+1', command: 'secondarySidebar.showFiles' },
        });
    });

    it('ignores a keystroke no binding claims', () => {
        expect(step(keyEvent('q', { metaKey: true }))).toEqual({ kind: 'ignore' });
    });
});

/**
 * Issue #1093: a global shortcut typed during the gap between a picker deciding to close and its modal registration
 * actually clearing reads `isModalOpen()` as stale-true and is silently swallowed — even the shortcut that would reopen
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
     * binding itself would explain a no-op — only the modal gate can.
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

        // The keystroke is still consumed — it must not leak into whatever the window falls back to — it just does
        // nothing, matching the reported symptom exactly: the overlay never reopens, and a retry works.
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(useDialogStore.getState().projectSearchOpen).toBe(false);
    });

    it('honors the same shortcut once the handoff has settled and the registration is clear', () => {
        useWorkbenchStore.setState({
            bootstrap: { keybindings: [projectSearchShortcut] } as unknown as BootstrapState,
        });

        const { event, preventDefault } = projectSearchKeydownEvent();
        dispatchGlobalKeydown(createGlobalShortcutDispatchState(), event);

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(useDialogStore.getState().projectSearchOpen).toBe(true);
    });
});

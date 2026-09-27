import { useEffect } from 'react';

import type { CommandId, Keybinding } from '@caxri/protocol';
import { buildChordLeadingChords } from '@caxri/protocol';

import {
    executeEditableViewCatalogShortcut,
    executeViewCatalogShortcut,
    getCachedViewCatalogCommandAllowedInEditable,
} from '../features/view-containers/view-container-commands';
import {
    buildShortcutMap,
    isEditableEventTarget,
    isEditorEventTarget,
    isKeybindingRecordingEventTarget,
    isModifierKey,
    isTerminalEventTarget,
    keyboardEventShortcut,
    resolveShortcutBinding,
} from '../lib/keybindings';
import { useDialogStore } from '../stores/dialogs';
import { useWorkbenchStore } from '../stores/workbench';
import { isCommandAvailable, runCommand } from './execute';
import type { SessionMruShortcutInvocation } from './registry';
import { getRegisteredCommand } from './registry';

function sessionMruShortcutInvocation(event: KeyboardEvent): SessionMruShortcutInvocation {
    return {
        direction: event.shiftKey ? -1 : 1,
        heldModifiers: [
            event.altKey && 'Alt',
            event.ctrlKey && 'Control',
            event.metaKey && 'Meta',
        ].filter((modifier): modifier is SessionMruShortcutInvocation['heldModifiers'][number] =>
            Boolean(modifier),
        ),
        triggerCode: event.code,
    };
}

/**
 * Shift reverses Session MRU instead of defining a second configurable binding. On a US macOS layout it also changes
 * the Backquote key's printable value to `~`, so an exact lookup cannot find the configured Command+Backquote chord.
 * Only the MRU command may fall back to the same chord without Shift; every other shifted chord keeps exact first-match
 * semantics.
 */
export function resolveKeydownBinding(
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>,
    event: KeyboardEvent,
    context: { terminalFocus: boolean },
): Keybinding | undefined {
    const exact = resolveShortcutBinding(shortcutMap, keyboardEventShortcut(event), context);
    if (exact || !event.shiftKey) return exact;
    const unshifted = resolveShortcutBinding(
        shortcutMap,
        keyboardEventShortcut(event, {
            mainKey: event.code === 'Backquote' ? '`' : undefined,
            omitShift: true,
        }),
        context,
    );
    return unshifted?.command === 'session.switchMru' ? unshifted : undefined;
}

/**
 * The chord a previous keystroke armed, waiting for the keystroke that completes the sequence.
 */
export interface PendingChord {
    leadingChord: string;
    /**
     * True when the leading chord was released to Monaco instead of consumed. Ownership of a sequence is decided by the
     * focus at its first keystroke, so the continuation follows the same owner even if focus moved in between.
     */
    yieldToEditor: boolean;
}

/**
 * What dispatch must do with one keystroke.
 *
 * - `ignore` — no binding matched; the keystroke belongs to whatever is focused.
 * - `armChord` — the keystroke opens a sequence. Consumed unless it was released to Monaco.
 * - `yieldChordContinuation` — the editor owns this sequence; the continuation is Monaco's, untouched.
 * - `cancelChord` — a Caxri-owned sequence matched nothing. The keystroke is swallowed so a half-typed chord never leaks
 *   its second key into a Terminal or an input.
 * - `dispatch` — run `binding`.
 */
export type KeystrokeOutcome =
    | { kind: 'armChord'; leadingChord: string; yieldToEditor: boolean }
    | { kind: 'cancelChord' }
    | { kind: 'dispatch'; binding: Keybinding }
    | { kind: 'ignore' }
    | { kind: 'yieldChordContinuation' };

interface KeystrokeInput {
    editorFocus: boolean;
    event: KeyboardEvent;
    leadingChords: ReadonlySet<string>;
    pending: PendingChord | undefined;
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>;
    terminalFocus: boolean;
}

/**
 * Single-keystroke step of the chord state machine, kept pure so both branches of the editor split are testable without
 * a DOM.
 *
 * Caxri and Monaco run independent keybinding resolvers, and Caxri cannot see that Monaco is mid-chord. Rather than
 * guess, ownership is decided once, at the leading chord: with the editor focused the whole sequence is Monaco's and
 * Caxri stands down for both keystrokes, which is what keeps `Cmd+K Cmd+1` folding instead of switching the Secondary
 * Side Bar. Everywhere else Caxri owns the sequence outright.
 */
export function resolveKeystroke({
    editorFocus,
    event,
    leadingChords,
    pending,
    shortcutMap,
    terminalFocus,
}: KeystrokeInput): KeystrokeOutcome {
    const context = { terminalFocus };
    if (pending) {
        if (pending.yieldToEditor) return { kind: 'yieldChordContinuation' };
        const binding = resolveShortcutBinding(
            shortcutMap,
            `${pending.leadingChord} ${keyboardEventShortcut(event)}`,
            context,
        );
        if (binding) return { kind: 'dispatch', binding };
        /**
         * Escape is how a user backs out of anything, and a pending chord is invisible. Swallowing it would eat the
         * press meant to close the dialog or popup the chord was accidentally armed over, so Escape ends the sequence
         * and still reaches whatever is listening.
         */
        return event.key === 'Escape' ? { kind: 'ignore' } : { kind: 'cancelChord' };
    }
    if (leadingChords.has(keyboardEventShortcut(event)))
        return {
            kind: 'armChord',
            leadingChord: keyboardEventShortcut(event),
            yieldToEditor: editorFocus,
        };
    const binding = resolveKeydownBinding(shortcutMap, event, context);
    return binding ? { kind: 'dispatch', binding } : { kind: 'ignore' };
}

const chordDispatchState: { pendingAtLastKeystroke?: string } = {};

/**
 * The chord that was pending when the most recent keystroke arrived, before dispatch resolved it.
 *
 * Screencast Mode describes keystrokes with its own privacy filter and therefore looks bindings up a second time; it
 * would otherwise resolve the continuation of `Cmd+K Cmd+S` as the unrelated single-chord `Cmd+S` and caption the
 * overlay "Save". Reading the chord state here keeps one state machine instead of a second copy, and works because
 * {@link useCommandShortcuts} is mounted for the whole app lifetime, so its capture listener always runs first.
 */
export function leadingChordAtLastKeystroke(): string | undefined {
    return chordDispatchState.pendingAtLastKeystroke;
}

/**
 * The mutable, per-mount state one keydown handler needs between keystrokes: the cached binding lookup tables and
 * whatever chord is mid-sequence. Kept as a plain object rather than closured `let`s so {@link dispatchGlobalKeydown} is
 * callable directly from a test without going through `useEffect` and a real `window` — see
 * `use-command-shortcuts.test.ts` for the regression this exists to make possible (issue #1093).
 */
export interface GlobalShortcutDispatchState {
    cachedKeybindings: Keybinding[] | undefined;
    shortcutMap: Map<string, Keybinding[]>;
    leadingChords: Set<string>;
    pending: PendingChord | undefined;
}

export function createGlobalShortcutDispatchState(): GlobalShortcutDispatchState {
    return {
        cachedKeybindings: undefined,
        shortcutMap: new Map(),
        leadingChords: new Set(),
        pending: undefined,
    };
}

/**
 * Global keyboard dispatch for one keystroke. Capture phase lets opted-in commands run before xterm or Monaco stop an
 * editable target's event. The binding table is read from the store at keystroke time, so the listener installed by
 * {@link useCommandShortcuts} is created once instead of being torn down on every snapshot refresh. The lookup tables
 * are rebuilt only when the keybinding array reference changes (a settings update), not on every keystroke.
 *
 * A bound shortcut is always consumed, even while a modal is open: `Command+W` must not fall through to Electron's
 * window close just because {@link runCommand} declines to act behind a dialog.
 */
export function dispatchGlobalKeydown(
    state: GlobalShortcutDispatchState,
    event: KeyboardEvent,
): void {
    // Published before any early return so a later capture listener always reads the chord state this
    // keystroke arrived with, never the previous keystroke's.
    chordDispatchState.pendingAtLastKeystroke = state.pending?.leadingChord;
    /**
     * An IME composition keystroke (e.g. picking a Pinyin candidate) is not a shortcut.
     */
    if (event.isComposing) return;
    if (isKeybindingRecordingEventTarget(event.target)) {
        state.pending = undefined;
        return;
    }
    if (isModifierKey(event.key)) return;
    const bootstrap = useWorkbenchStore.getState().bootstrap;
    if (!bootstrap) return;
    if (bootstrap.keybindings !== state.cachedKeybindings) {
        state.cachedKeybindings = bootstrap.keybindings;
        state.shortcutMap = buildShortcutMap(state.cachedKeybindings);
        state.leadingChords = buildChordLeadingChords(state.cachedKeybindings);
    }
    const isChordContinuation = state.pending !== undefined;
    const outcome = resolveKeystroke({
        editorFocus: isEditorEventTarget(event.target),
        event,
        leadingChords: state.leadingChords,
        pending: state.pending,
        shortcutMap: state.shortcutMap,
        terminalFocus: isTerminalEventTarget(event.target),
    });
    state.pending = undefined;
    if (outcome.kind === 'ignore' || outcome.kind === 'yieldChordContinuation') return;
    if (outcome.kind === 'armChord') {
        state.pending = {
            leadingChord: outcome.leadingChord,
            yieldToEditor: outcome.yieldToEditor,
        };
        // Monaco only enters its own chord mode if it actually receives the leading chord.
        if (outcome.yieldToEditor) return;
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    if (outcome.kind === 'cancelChord') {
        event.preventDefault();
        event.stopPropagation();
        return;
    }
    const binding = outcome.binding;
    const commandId = binding.command;
    const definition = getRegisteredCommand(commandId);
    /**
     * A contextual shortcut must fall through untouched so the owning editor can handle the same chord (Terminal
     * `Cmd+F` versus Monaco's native Find widget).
     */
    if (definition && !isCommandAvailable(commandId)) return;
    /**
     * The terminal and the editor are editable surfaces too; only opted-in commands reach through. A chord continuation
     * is exempt: its leading chord was already consumed by Caxri, which only happens outside the editor, and a
     * two-chord sequence can never be text the focused surface was about to receive.
     */
    const isEditable = !isChordContinuation && isEditableEventTarget(event.target);
    if (isEditable && !definition) {
        const cachedPermission = getCachedViewCatalogCommandAllowedInEditable(commandId);
        if (cachedPermission !== true) {
            if (cachedPermission === undefined) {
                event.preventDefault();
                event.stopPropagation();
                // Fire-and-forget: the manifest lookup is the fail-safe gate for a cold extension catalog.
                // eslint-disable-next-line no-void -- one keydown owns one asynchronous policy lookup
                void executeEditableViewCatalogShortcut(
                    commandId,
                    binding.args ? [binding.args] : [],
                );
            }
            return;
        }
    }
    if (isEditable && definition && !definition.allowInEditable) return;
    event.preventDefault();
    event.stopPropagation();
    if (useDialogStore.getState().isModalOpen()) return;
    if (definition)
        runCommand(
            commandId as CommandId,
            commandId === 'session.switchMru'
                ? { ...binding.args, shortcut: sessionMruShortcutInvocation(event) }
                : binding.args,
        );
    else {
        // Fire-and-forget: the shared shortcut helper reports catalog and command failures through toasts.
        // eslint-disable-next-line no-void -- one keydown owns one asynchronous extension command dispatch
        void executeViewCatalogShortcut(commandId, binding.args ? [binding.args] : []);
    }
}

/**
 * Mounts the window-level capture listener that feeds every keystroke to {@link dispatchGlobalKeydown}.
 */
export function useCommandShortcuts(): void {
    useEffect(() => {
        const state = createGlobalShortcutDispatchState();
        const onKeyDown = (event: KeyboardEvent): void => dispatchGlobalKeydown(state, event);
        /**
         * A pending chord is only ever completed by the very next keystroke. Clicking elsewhere or leaving the window
         * ends the sequence the user started, so the next key is read fresh instead of being swallowed as a stale
         * continuation.
         */
        const cancelPendingChord = (): void => {
            state.pending = undefined;
        };
        addEventListener('keydown', onKeyDown, { capture: true });
        addEventListener('mousedown', cancelPendingChord, { capture: true });
        addEventListener('blur', cancelPendingChord);
        return () => {
            removeEventListener('keydown', onKeyDown, { capture: true });
            removeEventListener('mousedown', cancelPendingChord, { capture: true });
            removeEventListener('blur', cancelPendingChord);
        };
    }, []);
}

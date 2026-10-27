import type { Keybinding } from '@caxri/protocol';

import type { KeybindingContext } from '../lib/keybindings';
import { keyboardEventShortcut, resolveShortcutBinding } from '../lib/keybindings';

/*
 * The keystroke-to-binding step of shortcut dispatch, kept free of the command registry so a companion window such as
 * Caxri Bot resolves chords exactly as the Workbench does without loading the Workbench commands (and the
 * Monaco they reach).
 */

/**
 * Shift reverses Session MRU instead of defining a second configurable binding. On a US macOS layout it also changes
 * the Backquote key's printable value to `~`, so an exact lookup cannot find the configured Command+Backquote chord.
 * Only the MRU command may fall back to the same chord without Shift; every other shifted chord keeps exact first-match
 * semantics.
 */
export function resolveKeydownBinding(
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>,
    event: KeyboardEvent,
    context: KeybindingContext,
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
 * - `ignore`: no binding matched; the keystroke belongs to whatever is focused.
 * - `armChord`: the keystroke opens a sequence. Consumed unless it was released to Monaco.
 * - `yieldChordContinuation`: the editor owns this sequence; the continuation is Monaco's, untouched.
 * - `cancelChord`: a Caxri-owned sequence matched nothing. The keystroke is swallowed so a half-typed chord never leaks
 *   its second key into a Terminal or an input.
 * - `dispatch`: run `binding`.
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
    isCommandAvailable?: KeybindingContext['isCommandAvailable'];
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
    isCommandAvailable,
    leadingChords,
    pending,
    shortcutMap,
    terminalFocus,
}: KeystrokeInput): KeystrokeOutcome {
    const context = { isCommandAvailable, terminalFocus };
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

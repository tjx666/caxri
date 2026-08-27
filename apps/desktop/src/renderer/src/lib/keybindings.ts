import { useMemo } from 'react';

import type { CommandId, Keybinding } from '@caxri/protocol';
import { normalizeShortcut } from '@caxri/protocol';

import { useWorkbenchStore } from '../stores/workbench';

/**
 * MacOS composes Option+<letter> into a symbol: `Option+P` reports `event.key === 'π'`, so a chord built from
 * `event.key` could never match a stored `alt+p` — every Option+letter binding was dead, both at dispatch and while
 * recording one in Settings. Alt chords therefore read the physical `event.code`, which stays stable for the letter and
 * digit rows. Non-Alt chords keep using `event.key` so a remapped or non-US layout still records what the user actually
 * typed.
 */
function shortcutMainKey(event: KeyboardEvent): string {
    if (event.altKey) {
        const letter = /^Key([A-Z])$/.exec(event.code);
        if (letter) return letter[1].toLowerCase();
        const digit = /^Digit(\d)$/.exec(event.code);
        if (digit) return digit[1];
    }
    const mainKey = event.key === ' ' ? 'space' : event.key;
    return mainKey.length === 1 ? mainKey : mainKey.toLowerCase();
}

export function keyboardEventShortcut(
    event: KeyboardEvent,
    { mainKey, omitShift = false }: { mainKey?: string; omitShift?: boolean } = {},
): string {
    return normalizeShortcut(
        [
            event.metaKey && 'cmd',
            event.ctrlKey && 'ctrl',
            event.altKey && 'alt',
            event.shiftKey && !omitShift && 'shift',
            mainKey ?? shortcutMainKey(event),
        ]
            .filter(Boolean)
            .join('+'),
    );
}

/**
 * Normalized chord -> bindings in source order, built once per keybinding change instead of scanning the whole table on
 * every keystroke. Keeping every declaration lets a contextual binding fall through to the next declaration when its
 * `when` clause is inactive while preserving the existing first-match-wins rule.
 */
export function buildShortcutMap(keybindings: readonly Keybinding[]): Map<string, Keybinding[]> {
    const map = new Map<string, Keybinding[]>();
    for (const binding of keybindings) {
        const chord = normalizeShortcut(binding.key);
        const entries = map.get(chord);
        if (entries) entries.push(binding);
        else map.set(chord, [binding]);
    }
    return map;
}

export interface KeybindingContext {
    terminalFocus: boolean;
}

/**
 * Resolves the first source-ordered binding whose supported context is active.
 */
export function resolveShortcutBinding(
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>,
    shortcut: string,
    context: KeybindingContext,
): Keybinding | undefined {
    return shortcutMap
        .get(shortcut)
        ?.find((binding) => binding.when === undefined || context[binding.when]);
}

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable], .monaco-editor, .xterm';
const TERMINAL_SELECTOR = '.xterm';
const KEYBINDING_RECORDING_SELECTOR = '[data-keybinding-recording="true"]';

function eventTargetClosest(target: EventTarget | null, selector: string): unknown {
    if (!target) return;
    const closest = (target as unknown as { closest?: unknown }).closest;
    if (typeof closest !== 'function') return;
    return Reflect.apply(closest, target, [selector]);
}

/**
 * True when the event target is (or is nested inside) an editable surface: a form control, a `contenteditable` region,
 * the Monaco editor, or an xterm pane. Global shortcuts must stand down for these unless the matched command opts in
 * with `allowInEditable`.
 */
export function isEditableEventTarget(target: EventTarget | null): boolean {
    return eventTargetClosest(target, EDITABLE_SELECTOR) != null;
}

/**
 * Matches VS Code's `terminalFocus` keybinding context against the concrete xterm event target.
 */
export function isTerminalEventTarget(target: EventTarget | null): boolean {
    return eventTargetClosest(target, TERMINAL_SELECTOR) != null;
}

/**
 * Keybinding recording intentionally receives a chord already assigned to an app command. The global capture listener
 * normally consumes such chords before a target handler can see them, so the active recorder carries a narrow marker
 * that lets only that control bypass app-wide dispatch while modal safety remains intact everywhere else.
 */
export function isKeybindingRecordingEventTarget(target: EventTarget | null): boolean {
    return eventTargetClosest(target, KEYBINDING_RECORDING_SELECTOR) != null;
}

/**
 * Looks up the live raw keybinding for a command; presentation belongs to `ShortcutBadge`.
 */
export function useCommandShortcut(commandId: CommandId): string | undefined {
    const keybindings = useWorkbenchStore((state) => state.bootstrap?.keybindings);
    return useMemo(() => {
        const binding = keybindings?.find((item) => item.command === commandId);
        return binding?.key;
    }, [keybindings, commandId]);
}

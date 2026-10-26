import { useMemo } from 'react';

import type { CommandId, Keybinding } from '@caxri/protocol';
import { normalizeShortcut } from '@caxri/protocol';

import { useWorkbenchStore } from '../stores/workbench';

/**
 * MacOS composes Option+<letter> into a symbol: `Option+P` reports `event.key === 'π'`, so a chord built from
 * `event.key` could never match a stored `alt+p`: every Option+letter binding was dead, both at dispatch and while
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
 * Normalized keybinding -> bindings in source order, built once per keybinding change instead of scanning the whole
 * table on every keystroke. Keeping every declaration lets a contextual binding fall through to the next declaration
 * when its `when` clause is inactive while preserving the existing first-match-wins rule.
 *
 * A two-chord binding is stored under its whole normalized key (`cmd+k cmd+s`), which no single keystroke can produce.
 * Dispatch reaches it by joining the pending chord to the current one; `buildChordLeadingChords` supplies the set that
 * tells dispatch a keystroke opens a sequence.
 */
export function buildShortcutMap(keybindings: readonly Keybinding[]): Map<string, Keybinding[]> {
    const map = new Map<string, Keybinding[]>();
    for (const binding of keybindings) {
        const shortcut = normalizeShortcut(binding.key);
        const entries = map.get(shortcut);
        if (entries) entries.push(binding);
        else map.set(shortcut, [binding]);
    }
    return map;
}

const MODIFIER_KEY_NAMES = new Set(['Alt', 'Control', 'Meta', 'Shift']);

/**
 * A lone modifier press is never a shortcut: it only arms the recorder, and, more load-bearing, it must not count as
 * the second chord of a pending sequence. Typing `Cmd+K Cmd+S` by releasing and re-pressing Command emits a bare `Meta`
 * keydown in between, which would otherwise cancel the chord before the real second chord arrives.
 */
export function isModifierKey(key: string): boolean {
    return MODIFIER_KEY_NAMES.has(key);
}

export interface KeybindingContext {
    terminalFocus: boolean;
    /**
     * Whether a binding's command can run right now. A command that cannot (Allow Request with no approval waiting)
     * passes the key on to the next binding for it, so a user's own binding on a default's key still works.
     */
    isCommandAvailable?: (command: string) => boolean;
}

/**
 * Resolves the first source-ordered binding whose supported context is active and whose command is available.
 */
export function resolveShortcutBinding(
    shortcutMap: ReadonlyMap<string, readonly Keybinding[]>,
    shortcut: string,
    context: KeybindingContext,
): Keybinding | undefined {
    return shortcutMap
        .get(shortcut)
        ?.find(
            (binding) =>
                (binding.when === undefined || context[binding.when]) &&
                (context.isCommandAvailable?.(binding.command) ?? true),
        );
}

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable], .monaco-editor, .xterm';
const TERMINAL_SELECTOR = '.xterm';
const KEYBINDING_RECORDING_SELECTOR = '[data-keybinding-recording="true"]';

interface ClosestEventTarget extends EventTarget {
    closest(selector: string): unknown;
}

function hasClosest(target: EventTarget): target is ClosestEventTarget {
    return 'closest' in target && typeof target.closest === 'function';
}

function eventTargetClosest(target: EventTarget | null, selector: string): unknown {
    if (!target || !hasClosest(target)) return;
    return target.closest(selector);
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
 * Monaco consumes its chord continuations before the window's bubbling shortcut listener.
 */
export function isEditorEventTarget(target: EventTarget | null): boolean {
    return eventTargetClosest(target, '.monaco-editor') != null;
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
 * Non-subscribing read of a command's live shortcut, for builders that run at the moment a menu opens rather than on
 * every render.
 */
export function readCommandShortcut(commandId: CommandId): string | undefined {
    return useWorkbenchStore
        .getState()
        .bootstrap?.keybindings.find((item) => item.command === commandId)?.key;
}

/**
 * Looks up the live raw keybinding for a command; presentation belongs to `ShortcutBadge`. A row that may carry no
 * command passes `undefined` and gets no shortcut, so lists can call it unconditionally.
 */
export function useCommandShortcut(commandId: CommandId | undefined): string | undefined {
    const keybindings = useWorkbenchStore((state) => state.bootstrap?.keybindings);
    return useMemo(() => {
        const binding = keybindings?.find((item) => item.command === commandId);
        return binding?.key;
    }, [keybindings, commandId]);
}

const ARIA_MODIFIERS: Readonly<Record<string, string>> = {
    alt: 'Alt',
    cmd: 'Meta',
    ctrl: 'Control',
    shift: 'Shift',
};

const ARIA_KEY_NAMES: Readonly<Record<string, string>> = {
    arrowdown: 'ArrowDown',
    arrowleft: 'ArrowLeft',
    arrowright: 'ArrowRight',
    arrowup: 'ArrowUp',
    pagedown: 'PageDown',
    pageup: 'PageUp',
    space: 'Space',
};

/**
 * A stored keybinding as `aria-keyshortcuts` spells it (`cmd+enter` reads `Meta+Enter`), so assistive technology hears
 * the key the user actually bound. A chord sequence (`cmd+k cmd+s`) has no spelling there, because the attribute uses
 * spaces to separate alternatives, and gets none.
 */
export function ariaKeyShortcuts(shortcut: string | undefined): string | undefined {
    if (!shortcut || shortcut.includes(' ')) return undefined;
    const parts = normalizeShortcut(shortcut).split('+');
    const key = parts.pop() ?? '';
    const name =
        ARIA_KEY_NAMES[key] ??
        (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1));
    return [...parts.map((part) => ARIA_MODIFIERS[part] ?? part), name].join('+');
}

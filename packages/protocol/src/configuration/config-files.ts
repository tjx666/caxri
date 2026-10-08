import { z } from 'zod';

import type { Keybinding, KeybindingConflict } from '../domain/domain.js';
import { keybindingSchema } from '../domain/domain.js';
import { MAX_KEYBINDINGS } from './configuration-contract.js';
import { normalizeShortcut, shortcutLeadingChord } from './shortcuts.js';

/**
 * True when two keybindings cannot coexist: the same normalized keybinding, or a single-chord binding standing on the
 * chord that opens the other's sequence. Dispatch arms the pending chord whenever one exists, so `cmd+k` and `cmd+k
 * cmd+s` are not two independent bindings: the single-chord one could never fire.
 */
function areShortcutsColliding(left: string, right: string): boolean {
    if (left === right) return true;
    return shortcutLeadingChord(left) === right || shortcutLeadingChord(right) === left;
}

/**
 * Chords reserved as sequence openers whether or not a binding currently uses them. `Cmd+K` opens every Monaco editor
 * chord, so deriving it from the live binding table alone would resurrect the collision it exists to prevent: remove
 * the last `cmd+k …` binding and the continuation of `Cmd+K Cmd+1` resolves as a standalone `Cmd+1` again, switching
 * the Secondary Side Bar instead of folding.
 */
const RESERVED_LEADING_CHORDS = ['cmd+k'];

/**
 * Chords that open a two-chord binding. Shared by Renderer dispatch, which arms its pending chord on this set even when
 * a single-chord binding claims the same chord, and by the native menu, which must not register such a chord as an
 * accelerator: Electron would consume it before the Renderer could start the sequence.
 *
 * `findKeybindingConflicts` reports the single-chord overlap so the shadowed binding is visible in Settings rather than
 * silently dead.
 */
export function buildChordLeadingChords(keybindings: readonly Keybinding[]): Set<string> {
    const leading = new Set<string>(RESERVED_LEADING_CHORDS);
    for (const binding of keybindings) {
        const chord = shortcutLeadingChord(binding.key);
        if (chord) leading.add(chord);
    }
    return leading;
}

export const keybindingsFileSchema = z.array(keybindingSchema).max(MAX_KEYBINDINGS);

export type DefaultKeybinding = Pick<Keybinding, 'args' | 'command' | 'key' | 'when'>;

type ArgumentFreeDefaultKeybinding = Omit<DefaultKeybinding, 'args'>;

export type DefaultKeybindingChange =
    | {
          type: 'add';
          binding: DefaultKeybinding;
      }
    | {
          type: 'replace';
          current: ArgumentFreeDefaultKeybinding;
          previous: ArgumentFreeDefaultKeybinding;
      };

export interface DefaultKeybindingReconciliation {
    additions: DefaultKeybinding[];
    replacements: Array<{ binding: ArgumentFreeDefaultKeybinding; index: number }>;
    value: Keybinding[];
}

/**
 * Reconciles reviewed built-in default changes without treating a user's keybinding file as a generated artifact.
 * Replacements require one exact argument-free old default and a free destination chord. Additions may carry command
 * arguments, but still require both a missing command and a free chord. Ambiguous duplicates, custom bindings, and
 * conflicts therefore fail closed.
 */
export function reconcileDefaultKeybindings(
    keybindings: readonly Keybinding[],
    changes: readonly DefaultKeybindingChange[],
): DefaultKeybindingReconciliation {
    const value = [...keybindings];
    const additions: DefaultKeybinding[] = [];
    const replacements: Array<{ binding: ArgumentFreeDefaultKeybinding; index: number }> = [];
    const isChordOccupied = (key: string, ignoredIndex?: number): boolean => {
        const shortcut = normalizeShortcut(key);
        // A chord that opens a sequence is never free for a single-chord default: dispatch would arm the pending
        // chord instead of running it.
        if (!shortcutLeadingChord(shortcut) && buildChordLeadingChords(value).has(shortcut))
            return true;
        return value.some(
            (binding, index) =>
                index !== ignoredIndex &&
                areShortcutsColliding(normalizeShortcut(binding.key), shortcut),
        );
    };

    for (const change of changes) {
        if (change.type === 'add') {
            if (
                value.length >= MAX_KEYBINDINGS ||
                value.some((binding) => binding.command === change.binding.command) ||
                isChordOccupied(change.binding.key)
            )
                continue;
            const binding = { ...change.binding };
            value.push(binding);
            additions.push(binding);
            continue;
        }

        const matchingIndexes = value.flatMap((binding, index) =>
            binding.args === undefined &&
            binding.command === change.previous.command &&
            binding.key === change.previous.key &&
            binding.when === change.previous.when
                ? [index]
                : [],
        );
        if (matchingIndexes.length !== 1) continue;
        const index = matchingIndexes[0];
        /**
         * A command rename often keeps its chord. The exact old default being replaced cannot conflict with itself,
         * while any other entry on that normalized chord must still preserve the user's file unchanged.
         */
        if (isChordOccupied(change.current.key, index)) continue;
        const binding = { ...change.current };
        value[index] = binding;
        replacements.push({ binding, index });
    }

    return { additions, replacements, value };
}

/**
 * Finds keybindings that cannot all work: several commands on one normalized keybinding, and a keybinding standing on a
 * chord that opens a sequence. Only the keybinding that cannot fire is reported: the sequence itself works, so warning
 * on its row would be noise.
 */
export function findKeybindingConflicts(keybindings: readonly Keybinding[]): KeybindingConflict[] {
    const commandsByKey = new Map<string, string[]>();
    for (const binding of keybindings) {
        const key = normalizeShortcut(binding.key);
        const commands = commandsByKey.get(key) ?? [];
        if (!commands.includes(binding.command)) commands.push(binding.command);
        commandsByKey.set(key, commands);
    }
    const leadingChords = buildChordLeadingChords(keybindings);
    const conflicts: KeybindingConflict[] = [];
    for (const [key, commands] of commandsByKey) {
        /**
         * Checked against {@link buildChordLeadingChords} rather than against the other keys, so the unconditionally
         * reserved `cmd+k` is caught even when no sequence currently uses it, exactly the state a user reaches by
         * removing the shipped `cmd+k …` defaults and binding something to the bare chord.
         */
        if (!shortcutLeadingChord(key) && leadingChords.has(key))
            conflicts.push({ key, commands, reason: 'chordPrefix' });
        else if (commands.length > 1) conflicts.push({ key, commands, reason: 'duplicate' });
    }
    return conflicts;
}

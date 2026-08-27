import { z } from 'zod';

import type { Keybinding, KeybindingConflict } from '../domain/domain.js';
import { keybindingSchema } from '../domain/domain.js';
import { MAX_KEYBINDINGS } from './configuration-contract.js';
import { normalizeShortcut } from './shortcuts.js';

export const keybindingsFileSchema = z.array(keybindingSchema).max(MAX_KEYBINDINGS);

export type DefaultKeybinding = Pick<Keybinding, 'command' | 'key' | 'when'>;

export type DefaultKeybindingChange =
    | {
          type: 'add';
          binding: DefaultKeybinding;
      }
    | {
          type: 'replace';
          current: DefaultKeybinding;
          previous: DefaultKeybinding;
      };

export interface DefaultKeybindingReconciliation {
    additions: DefaultKeybinding[];
    replacements: Array<{ binding: DefaultKeybinding; index: number }>;
    value: Keybinding[];
}

/**
 * Reconciles reviewed built-in default changes without treating a user's keybinding file as a generated artifact.
 * Replacements require one exact argument-free old default and a free destination chord. Additions require both a
 * missing command and a free chord. Ambiguous duplicates, custom bindings, and conflicts therefore fail closed.
 */
export function reconcileDefaultKeybindings(
    keybindings: readonly Keybinding[],
    changes: readonly DefaultKeybindingChange[],
): DefaultKeybindingReconciliation {
    const value = [...keybindings];
    const additions: DefaultKeybinding[] = [];
    const replacements: Array<{ binding: DefaultKeybinding; index: number }> = [];
    const isChordOccupied = (key: string): boolean => {
        const chord = normalizeShortcut(key);
        return value.some((binding) => normalizeShortcut(binding.key) === chord);
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
        if (matchingIndexes.length !== 1 || isChordOccupied(change.current.key)) continue;
        const index = matchingIndexes[0];
        const binding = { ...change.current };
        value[index] = binding;
        replacements.push({ binding, index });
    }

    return { additions, replacements, value };
}

/**
 * Finds normalized chords assigned to more than one distinct command.
 */
export function findKeybindingConflicts(keybindings: readonly Keybinding[]): KeybindingConflict[] {
    const byKey = new Map<string, Set<string>>();
    for (const binding of keybindings) {
        const key = normalizeShortcut(binding.key);
        const commands = byKey.get(key) ?? new Set<string>();
        commands.add(binding.command);
        byKey.set(key, commands);
    }
    const conflicts: KeybindingConflict[] = [];
    for (const [key, commands] of byKey)
        if (commands.size > 1) conflicts.push({ key, commands: [...commands] });
    return conflicts;
}

import { z } from 'zod';

import type { Keybinding, KeybindingConflict } from '../domain/domain.js';
import { keybindingSchema } from '../domain/domain.js';
import { MAX_KEYBINDINGS } from './configuration-contract.js';
import { normalizeShortcut } from './shortcuts.js';

export const keybindingsFileSchema = z.array(keybindingSchema).max(MAX_KEYBINDINGS);

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

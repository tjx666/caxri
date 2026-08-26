import type { Keybinding, KeybindingConflict } from '@caxri/protocol';
import { keybindingSchema, MAX_KEYBINDINGS } from '@caxri/protocol';
import { z } from 'zod';

import { normalizeShortcut } from './shortcuts';

/**
 * Settings validation lives in `packages/protocol/src/configuration`: `settings-spec.ts` is the per-field source of
 * truth and `settings-schema.ts` derives `appSettingsSchema` (the transform-free wire contract) and
 * `appSettingsFileSchema` (the lenient `settings.jsonc` parser producing the same `AppSettings` shape). Re-exported
 * here as the stable Desktop import path.
 */
export type {
    EnumSettingSpec,
    IntegerSettingSpec,
    SettingCategoryId,
    SettingKey,
    SettingSpec,
    StringSettingSpec,
} from '@caxri/protocol';
export { appSettingsFileSchema, defaultAppSettings } from '@caxri/protocol';
export { settingCategories, settingsSpecByKey } from '@caxri/protocol';

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

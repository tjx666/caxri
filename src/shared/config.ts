import { z } from 'zod';

import { MAX_KEYBINDINGS } from './config-contract';
import { normalizeShortcut } from './shortcuts';
import type { Keybinding, KeybindingConflict } from './types';
import { keybindingSchema } from './types';

/**
 * Settings validation lives in `packages/protocol/src/configuration`: `settings-spec.ts` is the per-field source of
 * truth and `settings-schema.ts` derives `appSettingsSchema` (the transform-free wire contract) and
 * `appSettingsFileSchema` (the lenient `settings.jsonc` parser producing the same `AppSettings` shape). Re-exported
 * here as the stable Desktop import path.
 */
export {
    appSettingsFileSchema,
    defaultAppSettings,
} from '../../packages/protocol/src/configuration/settings-schema';
export type {
    EnumSettingSpec,
    IntegerSettingSpec,
    SettingCategoryId,
    SettingKey,
    SettingSpec,
    StringSettingSpec,
} from '../../packages/protocol/src/configuration/settings-spec';
export {
    settingCategories,
    settingsSpecByKey,
} from '../../packages/protocol/src/configuration/settings-spec';

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

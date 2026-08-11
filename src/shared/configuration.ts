import { z } from 'zod';

import {
    agentProviderIds,
    defaultAgentProviderSettings,
    type AgentProvider,
    type AgentProviderSettings,
} from './agents';
import {
    DEFAULT_FILES_EXCLUDE,
    keybindingSchema,
    SETTINGS_BOUNDS,
    type AppSettings,
    type Keybinding,
    type KeybindingConflict,
} from './types';
import { normalizeShortcut } from './shortcuts';
import { MAX_KEYBINDINGS } from './configuration-contract';

const MAX_FILES_EXCLUDE_PATTERNS = 100;

const filesExcludeSchema = z
    .record(z.string().min(1).max(256), z.boolean())
    .refine((value) => Object.keys(value).length <= MAX_FILES_EXCLUDE_PATTERNS, {
        message: `files.exclude supports at most ${MAX_FILES_EXCLUDE_PATTERNS} patterns`,
    })
    .default({})
    .transform((value) => ({ ...DEFAULT_FILES_EXCLUDE, ...value }));

const agentLaunchSettingsSchema = z.object({
    executable: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(64),
});

const agentProviderSettingsSchema = z
    .partialRecord(
        z.enum(agentProviderIds),
        z.object({
            hooks: z.object({ enabled: z.boolean().default(false) }).default({ enabled: false }),
            launch: agentLaunchSettingsSchema,
        }),
    )
    .default({})
    .transform(
        (value) =>
            Object.fromEntries(
                agentProviderIds.map((provider) => [
                    provider,
                    value[provider] ?? structuredClone(defaultAgentProviderSettings[provider]),
                ]),
            ) as unknown as Record<AgentProvider, AgentProviderSettings>,
    );

/** Browser-safe single source of truth for Settings-file defaults and bounds. */
export const settingsFileSchema: z.ZodType<AppSettings, unknown> = z.object({
    'session.defaultAgent': z
        .enum([...agentProviderIds, 'shell'])
        .nullable()
        .default(null),
    'agents.providers': agentProviderSettingsSchema,
    'terminal.defaultWorkingDirectory': z
        .string()
        .trim()
        .min(1)
        .max(16_384)
        .nullable()
        .default(null),
    'terminal.fontSize': z
        .number()
        .int()
        .min(SETTINGS_BOUNDS['terminal.fontSize'].min)
        .max(SETTINGS_BOUNDS['terminal.fontSize'].max)
        .default(SETTINGS_BOUNDS['terminal.fontSize'].default),
    'terminal.scrollback': z
        .number()
        .int()
        .min(SETTINGS_BOUNDS['terminal.scrollback'].min)
        .max(SETTINGS_BOUNDS['terminal.scrollback'].max)
        .default(SETTINGS_BOUNDS['terminal.scrollback'].default),
    'terminal.copyOnSelect': z.boolean().default(SETTINGS_BOUNDS['terminal.copyOnSelect'].default),
    'files.exclude': filesExcludeSchema,
    'files.maxFileBytes': z
        .number()
        .int()
        .min(SETTINGS_BOUNDS['files.maxFileBytes'].min)
        .max(SETTINGS_BOUNDS['files.maxFileBytes'].max)
        .default(SETTINGS_BOUNDS['files.maxFileBytes'].default),
});

export const keybindingsFileSchema = z.array(keybindingSchema).max(MAX_KEYBINDINGS);

/** Finds normalized chords assigned to more than one distinct command. */
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

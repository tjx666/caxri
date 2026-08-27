import { z } from 'zod';

import {
    agentActionsSettingsFileSchema,
    agentActionsSettingsSchema,
} from '../agent/agent-action-settings.js';
import type { AgentProvider, AgentProviderSettings } from '../agent/agents.js';
import {
    agentProviderIds,
    defaultAgentOutputRecoverySettings,
    defaultAgentProviderSettings,
    MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS,
    MAX_AGENT_OUTPUT_RECOVERY_PATTERN_LENGTH,
    MAX_AGENT_OUTPUT_RECOVERY_PATTERNS,
    MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS,
} from '../agent/agents.js';
import type { IntegerSettingSpec, SettingKey, StringSettingSpec } from './settings-spec.js';
import { settingsSpecByKey } from './settings-spec.js';
import {
    MAX_TRUSTED_DOMAIN_LENGTH,
    MAX_TRUSTED_DOMAINS,
    normalizeTrustedDomainRule,
} from './trusted-domains.js';

/**
 * VS Code-style defaults for file-tree visibility; dependency and build output stay visible.
 */
export const DEFAULT_FILES_EXCLUDE = {
    '**/.git': true,
    '**/.hg': true,
    '**/.svn': true,
    '**/.DS_Store': true,
    '**/CVS': true,
    '**/Thumbs.db': true,
} as const;

const MAX_FILES_EXCLUDE_PATTERNS = 100;

const filesExcludeRecordSchema = z
    .record(z.string().min(1).max(256), z.boolean())
    .refine((value) => Object.keys(value).length <= MAX_FILES_EXCLUDE_PATTERNS, {
        message: `files.exclude supports at most ${MAX_FILES_EXCLUDE_PATTERNS} patterns`,
    });

const agentLaunchSettingsSchema = z.object({
    executable: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(64),
});

const agentHooksSettingsSchema = z
    .object({ enabled: z.boolean().default(false) })
    .default({ enabled: false });
const agentMessagingSettingsSchema = z
    .object({ enabled: z.boolean().default(true) })
    .default({ enabled: true });
const agentOutputRecoverySettingsSchema = z
    .object({
        enabled: z.boolean(),
        patterns: z
            .array(z.string().trim().min(1).max(MAX_AGENT_OUTPUT_RECOVERY_PATTERN_LENGTH))
            .max(MAX_AGENT_OUTPUT_RECOVERY_PATTERNS)
            .refine(
                (patterns) =>
                    new Set(patterns.map((pattern) => pattern.toLowerCase())).size ===
                    patterns.length,
                {
                    message: 'Recovery patterns must be unique',
                },
            ),
        settleDelayMs: z
            .number()
            .int()
            .min(MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS)
            .max(MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS),
        continueDelayMs: z
            .number()
            .int()
            .min(MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS)
            .max(MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS),
    })
    .default(defaultAgentOutputRecoverySettings);

const agentProviderSettingsSchema = z.object({
    actions: agentActionsSettingsSchema,
    hooks: agentHooksSettingsSchema,
    launch: agentLaunchSettingsSchema,
    messaging: agentMessagingSettingsSchema,
    recovery: agentOutputRecoverySettingsSchema,
});

const agentProviderSettingsFileSchema = agentProviderSettingsSchema.partial().extend({
    actions: agentActionsSettingsFileSchema.optional(),
});

/**
 * Wire shape: every catalog provider must be present. The Runtime always sends the filled record, so a missing provider
 * on the wire is a contract violation, not a default to repair.
 */
const agentProvidersSchema = z
    .record(z.enum(agentProviderIds), agentProviderSettingsSchema)
    .default(defaultAgentProviderSettings);

const trustedDomainRuleSchema = z.string().min(1).max(MAX_TRUSTED_DOMAIN_LENGTH);

const trustedDomainsSchema = z.array(trustedDomainRuleSchema).max(MAX_TRUSTED_DOMAINS).default([]);

/**
 * Maps a spec's option tuple to the literal value tuple `z.enum` needs, preserving inference.
 */
const enumValues = <const Options extends ReadonlyArray<{ value: string }>>(options: Options) =>
    options.map((option) => option.value) as { [K in keyof Options]: Options[K]['value'] };

const integerField = (spec: IntegerSettingSpec) =>
    z.number().int().min(spec.min).max(spec.max).default(spec.default);

const booleanField = (spec: { default: boolean }) => z.boolean().default(spec.default);

const nullableStringField = (spec: StringSettingSpec) =>
    z.string().trim().min(1).max(spec.maxLength).nullable().default(spec.default);

const spec = settingsSpecByKey;

/**
 * The canonical `AppSettings` schema shared by the IPC wire contract and the settings registry. Scalar bounds and
 * defaults come from `settings-spec.ts`; only values too rich for a generic control keep a hand-written sub-schema
 * above. Enum fields call `z.enum(enumValues(...))` inline — routing them through a generic helper defers the mapped
 * tuple type and TypeScript widens the values to `string`, losing the literal unions `AppSettings` consumers rely on.
 *
 * This schema stays transform-free so `z.toJSONSchema` introspection (`describeCaxriMethod`) can represent every method
 * payload; lenient `settings.jsonc` parsing lives in `appSettingsFileSchema` below.
 */
export const appSettingsSchema = z.object({
    'session.defaultAgent': z
        .enum(enumValues(spec['session.defaultAgent'].options))
        .nullable()
        .default(spec['session.defaultAgent'].default),
    'workbench.newWorktreeBehavior': z
        .enum(enumValues(spec['workbench.newWorktreeBehavior'].options))
        .default(spec['workbench.newWorktreeBehavior'].default),
    'primarySidebar.autoCollapseProjects': z
        .enum(enumValues(spec['primarySidebar.autoCollapseProjects'].options))
        .default(spec['primarySidebar.autoCollapseProjects'].default),
    'workbench.fontFamily': nullableStringField(spec['workbench.fontFamily']),
    'workbench.externalEditor': nullableStringField(spec['workbench.externalEditor']),
    'agents.providers': agentProvidersSchema,
    'git.fetchGitHubAvatars': booleanField(spec['git.fetchGitHubAvatars']),
    'security.trustedDomains': trustedDomainsSchema,
    'terminal.defaultWorkingDirectory': nullableStringField(
        spec['terminal.defaultWorkingDirectory'],
    ),
    /**
     * Deliberately not `nullableStringField`: its `.trim()` would strip the leading space, which is itself a meaningful
     * separator. An empty string is valid and means "whitespace only".
     */
    'terminal.wordSeparators': z
        .string()
        .max(spec['terminal.wordSeparators'].maxLength)
        .default(spec['terminal.wordSeparators'].default),
    'terminal.fontFamily': nullableStringField(spec['terminal.fontFamily']),
    'terminal.fontSize': integerField(spec['terminal.fontSize']),
    'editor.fontFamily': nullableStringField(spec['editor.fontFamily']),
    'terminal.scrollback': integerField(spec['terminal.scrollback']),
    'terminal.copyOnSelect': booleanField(spec['terminal.copyOnSelect']),
    'terminal.gpuAcceleration': z
        .enum(enumValues(spec['terminal.gpuAcceleration'].options))
        .default(spec['terminal.gpuAcceleration'].default),
    'terminal.osc52ClipboardWrite': booleanField(spec['terminal.osc52ClipboardWrite']),
    'files.exclude': filesExcludeRecordSchema.default(DEFAULT_FILES_EXCLUDE),
    'files.maxFileBytes': integerField(spec['files.maxFileBytes']),
} satisfies Record<SettingKey, z.ZodType>);

export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * All settings defaults in one object — `parse({})` lets every `.default()` fill in.
 */
export const defaultAppSettings: AppSettings = appSettingsSchema.parse({});

const filesExcludeFileSchema = filesExcludeRecordSchema
    .default({})
    .transform((value): Record<string, boolean> => ({ ...DEFAULT_FILES_EXCLUDE, ...value }));

const agentProvidersFileSchema = z
    .partialRecord(z.enum(agentProviderIds), agentProviderSettingsFileSchema)
    .default({})
    .transform(
        (value) =>
            Object.fromEntries(
                agentProviderIds.map((provider) => [
                    provider,
                    value[provider]
                        ? {
                              ...structuredClone(defaultAgentProviderSettings[provider]),
                              ...value[provider],
                          }
                        : structuredClone(defaultAgentProviderSettings[provider]),
                ]),
            ) as unknown as Record<AgentProvider, AgentProviderSettings>,
    );

const trustedDomainsFileSchema = z
    .array(trustedDomainRuleSchema)
    .max(MAX_TRUSTED_DOMAINS)
    .default([])
    .transform((values, context) => {
        const normalized: string[] = [];
        const seen = new Set<string>();
        for (const [index, value] of values.entries()) {
            const rule = normalizeTrustedDomainRule(value);
            if (!rule) {
                context.addIssue({
                    code: 'custom',
                    message: 'Expected an HTTP(S) origin or explicit *. subdomain rule',
                    path: [index],
                });
                continue;
            }
            if (!seen.has(rule)) {
                seen.add(rule);
                normalized.push(rule);
            }
        }
        return normalized;
    });

/**
 * Lenient parser for the user-authored `settings.jsonc`: a partial provider record fills from defaults, `files.exclude`
 * merges on top of the shipped exclusions, and trusted-domain rules are normalized and deduplicated. The output always
 * satisfies `AppSettings`, so everything past the parse boundary — including the IPC wire — only ever sees the
 * canonical shape.
 */
export const appSettingsFileSchema = appSettingsSchema.extend({
    'agents.providers': agentProvidersFileSchema,
    'security.trustedDomains': trustedDomainsFileSchema,
    'files.exclude': filesExcludeFileSchema,
});

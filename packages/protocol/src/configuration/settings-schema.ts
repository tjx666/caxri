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
import { agentDelegationSettingsSchema } from '../agent/delegation/agent-delegation-settings.js';
import {
    environmentMonitorMihomoSettingsFileSchema,
    environmentMonitorMihomoSettingsSchema,
    expectedEnvironmentTimeZoneFileSchema,
    expectedEnvironmentTimeZoneSchema,
} from './environment-monitor-settings.js';
import {
    MAX_IGNORED_CHECK_LENGTH,
    MAX_IGNORED_CHECKS,
    normalizeIgnoredCheckRule,
} from './ignored-checks.js';
import type { IntegerSettingSpec, SettingKey, StringSettingSpec } from './settings-spec.js';
import { settingsSpecByKey } from './settings-spec.js';
import {
    DEFAULT_LONG_RUNNING_SHELL_COMMANDS,
    MAX_SHELL_COMMAND_PATTERN_LENGTH,
    MAX_SHELL_COMMAND_PATTERNS,
    normalizeShellCommandPattern,
} from './shell-command-patterns.js';
import { terminalReferenceLinksSchema } from './terminal-reference-links.js';
import {
    MAX_TRUSTED_DOMAIN_LENGTH,
    MAX_TRUSTED_DOMAINS,
    normalizeTrustedDomainRule,
} from './trusted-domains.js';
import {
    MAX_TRUSTED_FOLDER_LENGTH,
    MAX_TRUSTED_FOLDERS,
    normalizeTrustedFolderRule,
} from './trusted-folders.js';

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
        message: `File exclusions support at most ${MAX_FILES_EXCLUDE_PATTERNS} patterns`,
    });

export const agentLaunchSettingsSchema = z.object({
    executable: z.string().trim().min(1).max(4_096),
    args: z.array(z.string().max(4_096)).max(64),
});

/**
 * Off by default: enabling writes Caxri-marked entries into each provider CLI's global config, and only PTY Terminal
 * Agents need them (Chat reports through its own SDK callbacks). Terminal panes suggest enabling them instead.
 */
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

const trustedFolderRuleSchema = z.string().min(1).max(MAX_TRUSTED_FOLDER_LENGTH);

const trustedFoldersSchema = z.array(trustedFolderRuleSchema).max(MAX_TRUSTED_FOLDERS).default([]);

const ignoredCheckRuleSchema = z.string().min(1).max(MAX_IGNORED_CHECK_LENGTH);

const ignoredChecksSchema = z.array(ignoredCheckRuleSchema).max(MAX_IGNORED_CHECKS).default([]);

const shellCommandPatternSchema = z.string().min(1).max(MAX_SHELL_COMMAND_PATTERN_LENGTH);

const longRunningShellCommandsSchema = z
    .array(shellCommandPatternSchema)
    .max(MAX_SHELL_COMMAND_PATTERNS)
    .default([...DEFAULT_LONG_RUNNING_SHELL_COMMANDS]);

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

const isRelayUrlShape = (value: string): boolean => {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    return (
        (url.protocol === 'ws:' || url.protocol === 'wss:') &&
        url.hostname.length > 0 &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
    );
};

/**
 * The canonical `AppSettings` schema shared by the IPC wire contract and the settings registry. Scalar bounds and
 * defaults come from `settings-spec.ts`; only values too rich for a generic control keep a hand-written sub-schema
 * above. Enum fields call `z.enum(enumValues(...))` inline: routing them through a generic helper defers the mapped
 * tuple type and TypeScript widens the values to `string`, losing the literal unions `AppSettings` consumers rely on.
 *
 * This schema stays transform-free so `z.toJSONSchema` introspection (`describeCaxriMethod`) can represent every method
 * payload; lenient `settings.jsonc` parsing lives in `appSettingsFileSchema` below.
 */
export const appSettingsSchema = z.object({
    'workbench.language': z
        .enum(enumValues(spec['workbench.language'].options))
        .nullable()
        .default(spec['workbench.language'].default),
    'notifications.worktreeFallback': booleanField(spec['notifications.worktreeFallback']),
    'notifications.agentRecovery': booleanField(spec['notifications.agentRecovery']),
    'session.defaultAgent': z
        .enum(enumValues(spec['session.defaultAgent'].options))
        .nullable()
        .default(spec['session.defaultAgent'].default),
    'session.openAgentsInChat': booleanField(spec['session.openAgentsInChat']),
    'agentChat.idleCompaction.enabled': booleanField(spec['agentChat.idleCompaction.enabled']),
    'agentChat.autoContinueAtUsageLimit': booleanField(spec['agentChat.autoContinueAtUsageLimit']),
    'agentChat.longPasteThreshold': integerField(spec['agentChat.longPasteThreshold']),
    'agentChat.workingIndicator': z
        .enum(enumValues(spec['agentChat.workingIndicator'].options))
        .default(spec['agentChat.workingIndicator'].default),
    'agentChat.animatedToolIcons': booleanField(spec['agentChat.animatedToolIcons']),
    'agentChat.statusShimmer': z
        .enum(enumValues(spec['agentChat.statusShimmer'].options))
        .default(spec['agentChat.statusShimmer'].default),
    'workbench.newWorktreeBehavior': z
        .enum(enumValues(spec['workbench.newWorktreeBehavior'].options))
        .default(spec['workbench.newWorktreeBehavior'].default),
    'workbench.confirmWorktreeAuthorization': booleanField(
        spec['workbench.confirmWorktreeAuthorization'],
    ),
    'workbench.removeWorktreeOnArchive': booleanField(spec['workbench.removeWorktreeOnArchive']),
    'workbench.theme.followSystem': booleanField(spec['workbench.theme.followSystem']),
    'workbench.theme.light': z
        .enum(enumValues(spec['workbench.theme.light'].options))
        .default(spec['workbench.theme.light'].default),
    'workbench.theme.dark': z
        .enum(enumValues(spec['workbench.theme.dark'].options))
        .default(spec['workbench.theme.dark'].default),
    'primarySidebar.autoCollapseProjects': z
        .enum(enumValues(spec['primarySidebar.autoCollapseProjects'].options))
        .default(spec['primarySidebar.autoCollapseProjects'].default),
    'primarySidebar.showSubagents': booleanField(spec['primarySidebar.showSubagents']),
    'primarySidebar.translucent': booleanField(spec['primarySidebar.translucent']),
    'zen.fullScreen': booleanField(spec['zen.fullScreen']),
    'zen.restore': booleanField(spec['zen.restore']),
    'statusBar.usage.limitWindows': z
        .enum(enumValues(spec['statusBar.usage.limitWindows'].options))
        .default(spec['statusBar.usage.limitWindows'].default),
    'window.zoomLevel': integerField(spec['window.zoomLevel']),
    'workbench.fontFamily': nullableStringField(spec['workbench.fontFamily']),
    'workbench.externalEditor': nullableStringField(spec['workbench.externalEditor']),
    'updates.skippedVersion': nullableStringField(spec['updates.skippedVersion']),
    /**
     * Only the URL shape is checked here; Server Core validates it again with the Relay contract before dialing.
     */
    'mobile.relayUrl': nullableStringField(spec['mobile.relayUrl']).refine(
        (value) => value === null || isRelayUrlShape(value),
        'Expected a ws:// or wss:// URL without credentials, query, or fragment',
    ),
    'agents.providers': agentProvidersSchema,
    'agents.delegation': agentDelegationSettingsSchema,
    'agents.longRunningShellCommands': longRunningShellCommandsSchema,
    /**
     * Not `nullableStringField`: `null` is Caxri's preset, while an empty value is the choice to add no instructions.
     */
    'agents.sessionInstructions': z
        .string()
        .max(spec['agents.sessionInstructions'].maxLength)
        .nullable()
        .default(spec['agents.sessionInstructions'].default),
    'agents.suggestLifecycleHooks': booleanField(spec['agents.suggestLifecycleHooks']),
    'agents.notifications.enabled': booleanField(spec['agents.notifications.enabled']),
    'agents.notifications.completionThresholdSeconds': integerField(
        spec['agents.notifications.completionThresholdSeconds'],
    ),
    'git.fetchGitHubAvatars': booleanField(spec['git.fetchGitHubAvatars']),
    'projectStatus.ignoredChecks': ignoredChecksSchema,
    'projectStatus.notifyAgentOnMerge': booleanField(spec['projectStatus.notifyAgentOnMerge']),
    'projectStatus.autoArchiveOnPullRequestSettled': booleanField(
        spec['projectStatus.autoArchiveOnPullRequestSettled'],
    ),
    'projectStatus.notifications.enabled': booleanField(
        spec['projectStatus.notifications.enabled'],
    ),
    'environmentMonitor.publicIpChanges': booleanField(spec['environmentMonitor.publicIpChanges']),
    'environmentMonitor.expectedTimeZone': expectedEnvironmentTimeZoneSchema,
    'environmentMonitor.mihomoRoutes': environmentMonitorMihomoSettingsSchema,
    'security.trustedDomains': trustedDomainsSchema,
    'security.trustedFolders': trustedFoldersSchema,
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
    'terminal.referenceLinks': terminalReferenceLinksSchema,
    'terminal.fontFamily': nullableStringField(spec['terminal.fontFamily']),
    'terminal.fontSize': integerField(spec['terminal.fontSize']),
    'files.autoSave': z
        .enum(enumValues(spec['files.autoSave'].options))
        .default(spec['files.autoSave'].default),
    'editor.fontFamily': nullableStringField(spec['editor.fontFamily']),
    'editor.fontSize': integerField(spec['editor.fontSize']),
    'editor.wordWrap': z
        .enum(enumValues(spec['editor.wordWrap'].options))
        .default(spec['editor.wordWrap'].default),
    // Same reason as `terminal.wordSeparators`: a leading space is itself a separator, so no `.trim()`.
    'editor.wordSeparators': z
        .string()
        .max(spec['editor.wordSeparators'].maxLength)
        .default(spec['editor.wordSeparators'].default),
    'editor.autoClosingDelete': z
        .enum(enumValues(spec['editor.autoClosingDelete'].options))
        .default(spec['editor.autoClosingDelete'].default),
    'editor.linkedEditing': booleanField(spec['editor.linkedEditing']),
    'editor.stickyScroll.enabled': booleanField(spec['editor.stickyScroll.enabled']),
    'editor.stickyTabStops': booleanField(spec['editor.stickyTabStops']),
    'editor.bracketPairColorization.enabled': booleanField(
        spec['editor.bracketPairColorization.enabled'],
    ),
    'editor.guides.bracketPairs': z
        .enum(enumValues(spec['editor.guides.bracketPairs'].options))
        .default(spec['editor.guides.bracketPairs'].default),
    'editor.renderWhitespace': z
        .enum(enumValues(spec['editor.renderWhitespace'].options))
        .default(spec['editor.renderWhitespace'].default),
    'editor.cursorBlinking': z
        .enum(enumValues(spec['editor.cursorBlinking'].options))
        .default(spec['editor.cursorBlinking'].default),
    'editor.cursorSmoothCaretAnimation': z
        .enum(enumValues(spec['editor.cursorSmoothCaretAnimation'].options))
        .default(spec['editor.cursorSmoothCaretAnimation'].default),
    'editor.smoothScrolling': booleanField(spec['editor.smoothScrolling']),
    'editor.dragAndDrop': booleanField(spec['editor.dragAndDrop']),
    'editor.minimap.enabled': booleanField(spec['editor.minimap.enabled']),
    'editor.unfoldOnClickAfterEndOfLine': booleanField(spec['editor.unfoldOnClickAfterEndOfLine']),
    'editor.foldOnOpenLineThreshold': integerField(spec['editor.foldOnOpenLineThreshold']),
    'terminal.scrollback': integerField(spec['terminal.scrollback']),
    'terminal.longPasteThreshold': integerField(spec['terminal.longPasteThreshold']),
    'terminal.copyOnSelect': booleanField(spec['terminal.copyOnSelect']),
    'terminal.gpuAcceleration': z
        .enum(enumValues(spec['terminal.gpuAcceleration'].options))
        .default(spec['terminal.gpuAcceleration'].default),
    'terminal.suspendUntouchedAgents': booleanField(spec['terminal.suspendUntouchedAgents']),
    'terminal.idleSuspension.enabled': booleanField(spec['terminal.idleSuspension.enabled']),
    'terminal.idleSuspension.afterMinutes': integerField(
        spec['terminal.idleSuspension.afterMinutes'],
    ),
    'terminal.osc52ClipboardWrite': booleanField(spec['terminal.osc52ClipboardWrite']),
    'files.exclude': filesExcludeRecordSchema.default(DEFAULT_FILES_EXCLUDE),
    /**
     * Files a reviewer scrolls past rather than reads. Tests are the obvious ones; translation catalogs are the same
     * shape of noise on a localized repository, where one product change rewrites `locales/<lang>/*.json` in every
     * language it ships and buries the source files that actually changed. One recursive `locales` glob covers both a
     * repository-root `locales/` and a `packages/locales/`. The eye button still shows them on demand.
     */
    /**
     * Empty by default so a review of an Agent's work never starts with its tests or translations silently hidden.
     */
    'git.diffExclude': filesExcludeRecordSchema.default({}),
    'files.maxFileBytes': integerField(spec['files.maxFileBytes']),
} satisfies Record<SettingKey, z.ZodType>);

export type AppSettings = z.infer<typeof appSettingsSchema>;

/**
 * All settings defaults in one object: `parse({})` lets every `.default()` fill in.
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

/**
 * Normalizes and deduplicates a user-authored rule list, reporting each unparseable entry at its own index.
 */
function normalizedRuleList(
    values: string[],
    context: z.RefinementCtx,
    normalizeRule: (value: string) => string | undefined,
    message: string,
): string[] {
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
        const rule = normalizeRule(value);
        if (!rule) {
            context.addIssue({ code: 'custom', message, path: [index] });
            continue;
        }
        if (!seen.has(rule)) {
            seen.add(rule);
            normalized.push(rule);
        }
    }
    return normalized;
}

const trustedDomainsFileSchema = z
    .array(trustedDomainRuleSchema)
    .max(MAX_TRUSTED_DOMAINS)
    .default([])
    .transform((values, context) =>
        normalizedRuleList(
            values,
            context,
            normalizeTrustedDomainRule,
            'Expected an HTTP(S) origin or explicit *. subdomain rule',
        ),
    );

const trustedFoldersFileSchema = z
    .array(trustedFolderRuleSchema)
    .max(MAX_TRUSTED_FOLDERS)
    .default([])
    .transform((values, context) =>
        normalizedRuleList(
            values,
            context,
            normalizeTrustedFolderRule,
            'Expected an absolute folder path',
        ),
    );

const ignoredChecksFileSchema = z
    .array(ignoredCheckRuleSchema)
    .max(MAX_IGNORED_CHECKS)
    .default([])
    .transform((values, context) =>
        normalizedRuleList(
            values,
            context,
            normalizeIgnoredCheckRule,
            'Expected a non-empty check name or glob pattern',
        ),
    );

const longRunningShellCommandsFileSchema = z
    .array(shellCommandPatternSchema)
    .max(MAX_SHELL_COMMAND_PATTERNS)
    .default([...DEFAULT_LONG_RUNNING_SHELL_COMMANDS])
    .transform((values, context) =>
        normalizedRuleList(
            values,
            context,
            normalizeShellCommandPattern,
            'Expected a shell command pattern or a valid /regular expression/',
        ),
    );

/**
 * Lenient parser for the user-authored `settings.jsonc`: a partial provider record fills from defaults, `files.exclude`
 * merges on top of the shipped exclusions, and trusted-domain rules are normalized and deduplicated. The output always
 * satisfies `AppSettings`, so everything past the parse boundary, including the IPC wire, only ever sees the canonical
 * shape.
 */
export const appSettingsFileSchema = appSettingsSchema.extend({
    'agents.providers': agentProvidersFileSchema,
    'agents.longRunningShellCommands': longRunningShellCommandsFileSchema,
    'projectStatus.ignoredChecks': ignoredChecksFileSchema,
    'environmentMonitor.expectedTimeZone': expectedEnvironmentTimeZoneFileSchema,
    'environmentMonitor.mihomoRoutes': environmentMonitorMihomoSettingsFileSchema,
    'security.trustedDomains': trustedDomainsFileSchema,
    'security.trustedFolders': trustedFoldersFileSchema,
    'files.exclude': filesExcludeFileSchema,
});

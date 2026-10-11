import { z } from 'zod';

import { commanderRunStateSchema } from '../agent/agent-commander-contract.js';
import { agentDelegationReceiptSchema } from '../agent/agent-delegation-contract.js';
import { agentDelegationSettingsSchema } from '../agent/agent-delegation-settings.js';
import { appSettingsSchema } from '../configuration/settings-schema.js';
import { projectListForPrincipal, projectListResultSchema } from '../registry/projections.js';
import {
    eventRecoveryRequestSchema,
    observableEventRecoverySchema,
} from '../transport/event-journal.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import { protocolVersionSchema } from '../transport/version.js';
import {
    humanProjectSchema,
    identifierSchema,
    scopedProjectSchema,
    sessionRecordSchema,
    terminalRecordSchema,
} from './domain.js';
import { logEventNameSchema } from './logging.js';

const noParameters = z.object({}).default({});
const principalViewSchema = z.enum([
    'desktop',
    'human-cli',
    'agent',
    'delegation-client',
    'extension',
    'paired-device',
]);
const listQuerySchema = z.object({ mode: z.literal('list') });
const showQuerySchema = z.object({
    mode: z.literal('show'),
    selector: z.string().trim().min(1).max(200),
});
const currentQuerySchema = z.object({ mode: z.literal('current') });

export const projectQuerySchema = z.discriminatedUnion('mode', [
    listQuerySchema,
    showQuerySchema,
    currentQuerySchema,
]);
export const sessionQuerySchema = z.discriminatedUnion('mode', [
    listQuerySchema.extend({ projectId: identifierSchema.optional() }),
    showQuerySchema.extend({ projectId: identifierSchema.optional() }),
    currentQuerySchema,
]);
export const terminalQuerySchema = z.discriminatedUnion('mode', [
    listQuerySchema.extend({ sessionId: identifierSchema.optional() }),
    showQuerySchema.extend({ sessionId: identifierSchema.optional() }),
]);

export const projectQueryResultSchema = z.union([
    z.object({
        view: z.enum(['desktop', 'human-cli']),
        projects: z.array(humanProjectSchema).max(1_024),
    }),
    z.object({
        view: z.enum(['agent', 'delegation-client', 'extension', 'paired-device']),
        projects: z.array(scopedProjectSchema).max(128),
    }),
]);

const sessionSummarySchema = sessionRecordSchema.pick({
    id: true,
    projectId: true,
    displayTitle: true,
    archivedAt: true,
    lastOpenedAt: true,
    lastActivityState: true,
    primaryAgentTerminalId: true,
    attentionEpoch: true,
    hasUnread: true,
});
export const sessionQueryResultSchema = z.object({
    view: principalViewSchema,
    sessions: z.array(sessionSummarySchema).max(4_096),
});

const terminalSummarySchema = terminalRecordSchema.pick({
    id: true,
    sessionId: true,
    kind: true,
    provider: true,
    title: true,
    lastProcessState: true,
    failureReason: true,
    /**
     * Present only for an Agent Chat, so a Client (or a paired phone) can tell it from a PTY before attaching.
     */
    surface: true,
});
export const terminalQueryResultSchema = z.object({
    view: principalViewSchema,
    terminals: z.array(terminalSummarySchema).max(8_192),
});

export const inspectableSettingsSchema = appSettingsSchema.pick({
    'session.defaultAgent': true,
    'workbench.newWorktreeBehavior': true,
    'notifications.worktreeFallback': true,
    'notifications.agentRecovery': true,
    'terminal.fontSize': true,
    'terminal.scrollback': true,
    'terminal.copyOnSelect': true,
    'terminal.gpuAcceleration': true,
    'terminal.osc52ClipboardWrite': true,
    'files.maxFileBytes': true,
    'updates.skippedVersion': true,
});
export const settingsPatchKeySchema = z.enum([
    'notifications.worktreeFallback',
    'notifications.agentRecovery',
    'session.defaultAgent',
    'workbench.newWorktreeBehavior',
    'terminal.fontSize',
    'terminal.scrollback',
    'terminal.copyOnSelect',
    'terminal.gpuAcceleration',
    'terminal.osc52ClipboardWrite',
    'files.maxFileBytes',
    'updates.skippedVersion',
]);
/**
 * Patch values reuse the bounded field schemas from `appSettingsSchema` with the `.default()` stripped: a patch must
 * always carry an explicit value, never silently fall back to the default.
 */
export const settingsPatchChangeSchema = z.discriminatedUnion('key', [
    z.object({
        key: z.literal('notifications.worktreeFallback'),
        value: appSettingsSchema.shape['notifications.worktreeFallback'].unwrap(),
    }),
    z.object({
        key: z.literal('notifications.agentRecovery'),
        value: appSettingsSchema.shape['notifications.agentRecovery'].unwrap(),
    }),
    z.object({
        key: z.literal('session.defaultAgent'),
        value: appSettingsSchema.shape['session.defaultAgent'].unwrap(),
    }),
    z.object({
        key: z.literal('workbench.newWorktreeBehavior'),
        /**
         * Agent-writable settings must not grant new filesystem authority; automatic following is a user choice.
         */
        value: appSettingsSchema.shape['workbench.newWorktreeBehavior']
            .unwrap()
            .exclude(['continueAutomatically']),
    }),
    z.object({
        key: z.literal('terminal.fontSize'),
        value: appSettingsSchema.shape['terminal.fontSize'].unwrap(),
    }),
    z.object({
        key: z.literal('terminal.scrollback'),
        value: appSettingsSchema.shape['terminal.scrollback'].unwrap(),
    }),
    z.object({
        key: z.literal('terminal.copyOnSelect'),
        value: appSettingsSchema.shape['terminal.copyOnSelect'].unwrap(),
    }),
    z.object({
        key: z.literal('terminal.gpuAcceleration'),
        value: appSettingsSchema.shape['terminal.gpuAcceleration'].unwrap(),
    }),
    z.object({
        key: z.literal('terminal.osc52ClipboardWrite'),
        value: appSettingsSchema.shape['terminal.osc52ClipboardWrite'].unwrap(),
    }),
    z.object({
        key: z.literal('files.maxFileBytes'),
        value: appSettingsSchema.shape['files.maxFileBytes'].unwrap(),
    }),
    z.object({
        key: z.literal('updates.skippedVersion'),
        /**
         * Reachable from the update dialog's `Skip this version` and its matching reset, which is why it takes this
         * structured single-key path rather than rewriting `settings.jsonc`. It grants no authority: the worst an
         * unwanted write can do is delay an update offer until the next release, and the Settings row makes that state
         * visible and clearable.
         */
        value: appSettingsSchema.shape['updates.skippedVersion'].unwrap(),
    }),
]);
export const settingsPatchParametersSchema = z.object({
    changes: z.array(settingsPatchChangeSchema).min(1).max(32),
    dryRun: z.boolean().default(false),
});
const settingsRevisionSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const settingsInspectionSchema = z.object({
    value: inspectableSettingsSchema,
    revision: settingsRevisionSchema,
    errors: z.array(z.string().max(2_048)).max(32),
});
export const settingsPatchResultSchema = settingsInspectionSchema.extend({
    dryRun: z.boolean(),
    changedKeys: z.array(settingsPatchKeySchema).max(32),
});

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);
export const logProcesses = ['desktop', 'extension-host', 'server-core', 'terminal-host'] as const;
export const logProcessSchema = z.enum(logProcesses);
export function isLogProcess(value: unknown): value is LogProcess {
    return typeof value === 'string' && logProcesses.includes(value as LogProcess);
}
export const logQueryParametersSchema = z
    .object({
        afterCursor: z.string().min(1).max(512).optional(),
        correlationId: z.string().min(1).max(200).optional(),
        event: logEventNameSchema.optional(),
        level: logLevelSchema.optional(),
        limit: z.number().int().min(1).max(100).default(50),
        process: logProcessSchema.optional(),
        since: z.iso.datetime().optional(),
    })
    .default({ limit: 50 });
const logFieldKeySchema = z.string().max(200);
const logFieldValueSchema = z.union([z.string().max(4_096), z.number(), z.boolean(), z.null()]);
export const logQueryRecordSchema = z.object({
    id: identifierSchema,
    timestamp: z.iso.datetime(),
    process: logProcessSchema,
    level: logLevelSchema,
    event: z.string().min(1).max(200),
    correlationId: z.string().min(1).max(200).optional(),
    durationMs: z.number().nonnegative().optional(),
    /**
     * Structured detail fields as written by the logger (already secret-redacted at write time by `safeFields`).
     * Bounded so a pathological line cannot inflate a query reply.
     */
    fields: z.record(logFieldKeySchema, logFieldValueSchema).optional(),
});
export const logQueryResultSchema = z.object({
    records: z.array(logQueryRecordSchema).max(100),
    nextCursor: z.string().min(1).max(512).optional(),
    gap: z.boolean(),
    truncated: z.boolean(),
});

const performanceSummarySchema = z.object({
    event: z.string().min(1).max(200),
    count: z.number().int().nonnegative(),
    averageMs: z.number().nonnegative(),
    minimumMs: z.number().nonnegative(),
    maximumMs: z.number().nonnegative(),
});
const watchHubSnapshotEntrySchema = z.object({
    label: z.string().min(1).max(100),
    native: z.number().int().nonnegative(),
    polling: z.number().int().nonnegative(),
    eventBatches: z.number().int().nonnegative(),
    lastEventAt: z.number().optional(),
});
/**
 * Content-free census of Runtime filesystem watchers and intentional pollers: labels and counters only, never paths.
 */
const watchHubSnapshotSchema = z.object({
    registrations: z.number().int().nonnegative(),
    native: z.number().int().nonnegative(),
    polling: z.number().int().nonnegative(),
    gateTrips: z.number().int().nonnegative(),
    entries: z.array(watchHubSnapshotEntrySchema).max(64),
});
/**
 * Upper bound on the recent Commander tasks a diagnostics snapshot lists.
 */
export const MAX_DIAGNOSTIC_COMMANDER_DELEGATIONS = 20;
const receiptShape = agentDelegationReceiptSchema.shape;
/**
 * One recent Commander task as receipt identity and state only: never its prompt, answer, or launch input.
 */
const commanderDelegationDiagnosticSchema = z.object({
    delegationId: receiptShape.delegationId,
    sessionId: receiptShape.sessionId,
    provider: receiptShape.provider,
    status: receiptShape.status,
    failure: receiptShape.failure,
    correlationFailure: receiptShape.correlationFailure,
    /**
     * Whether the current Commander Terminal sent the task, rather than another caller targeting a Commander Session.
     */
    isCommanderCaller: z.boolean(),
    createdAt: receiptShape.createdAt,
    updatedAt: receiptShape.updatedAt,
    /**
     * Time from admission to the receipt's latest transition; still growing while the task is active.
     */
    durationMs: z.number().int().nonnegative(),
});
/**
 * Completion notice delivery measured from the retained `agent_commander.completion_notice_*` log lines, so it covers
 * only what log rotation still keeps. `waitMs` is how long a batch's oldest notice waited for an idle Commander turn.
 */
const commanderCompletionNoticeDiagnosticSchema = z.object({
    deliveredBatches: z.number().int().nonnegative(),
    deliveredNotices: z.number().int().nonnegative(),
    /**
     * Relaunches that started the Commander with the notices it missed, and how many delegation notices they carried.
     */
    resumePrompts: z.number().int().nonnegative(),
    resumePromptNotices: z.number().int().nonnegative(),
    /**
     * Delegation notices persisted but not yet delivered when the snapshot was taken.
     */
    pendingNotices: z.number().int().nonnegative(),
    averageWaitMs: z.number().nonnegative().optional(),
    maximumWaitMs: z.number().nonnegative().optional(),
    deliveryFailures: z.object({
        rejected: z.number().int().nonnegative(),
        unconfirmed: z.number().int().nonnegative(),
    }),
});
/**
 * Content-free Agent Commander census: run state, its Terminal's process states, owned Session count, recent task
 * receipts, and completion notice latency. IDs, enums, counters, and durations only.
 */
export const agentCommanderDiagnosticsSchema = z.object({
    state: commanderRunStateSchema,
    terminalId: identifierSchema.optional(),
    terminalProcessState: terminalRecordSchema.shape.lastProcessState.optional(),
    agentProcessState: terminalRecordSchema.shape.lastAgentProcessState,
    sessionCount: z.number().int().nonnegative(),
    recentDelegations: z
        .array(commanderDelegationDiagnosticSchema)
        .max(MAX_DIAGNOSTIC_COMMANDER_DELEGATIONS),
    completionNotices: commanderCompletionNoticeDiagnosticSchema,
});
export type AgentCommanderDiagnostics = z.infer<typeof agentCommanderDiagnosticsSchema>;

export const diagnosticsSnapshotSchema = z.object({
    appVersion: z.string().min(1).max(100),
    protocolVersion: protocolVersionSchema,
    runtimeStatus: z.literal('ready'),
    startedAt: z.number().int().positive(),
    activePtyCount: z.number().int().nonnegative(),
    projectCount: z.number().int().nonnegative(),
    sessionCount: z.number().int().nonnegative(),
    terminalCount: z.number().int().nonnegative(),
    recentErrorIds: z.array(z.string().min(1).max(200)).max(5),
    performance: z.array(performanceSummarySchema).max(256),
    watchers: watchHubSnapshotSchema.optional(),
    agentCommander: agentCommanderDiagnosticsSchema,
});

export const businessMethods = {
    'project.list': {
        ...commandPolicy('server', 'read', ['projects.read']),
        params: noParameters,
        result: projectListResultSchema,
        projectResult: projectListForPrincipal,
    },
    'project.query': {
        ...commandPolicy('server', 'read', ['projects.read']),
        params: projectQuerySchema,
        result: projectQueryResultSchema,
    },
    'session.query': {
        ...commandPolicy('server', 'read', ['sessions.read']),
        params: sessionQuerySchema,
        result: sessionQueryResultSchema,
    },
    'terminal.query': {
        ...commandPolicy('server', 'read', ['terminals.read']),
        params: terminalQuerySchema,
        result: terminalQueryResultSchema,
    },
    'settings.inspect': {
        ...commandPolicy('server', 'read', ['settings.read']),
        params: noParameters,
        result: settingsInspectionSchema,
    },
    'settings.patch': {
        ...commandPolicy('server', 'write', ['settings.write']),
        params: settingsPatchParametersSchema,
        result: settingsPatchResultSchema,
    },
    'settings.delegation.import': {
        ...commandPolicy('server', 'write', ['settings.delegation.write']),
        params: z.strictObject({
            settings: agentDelegationSettingsSchema,
            dryRun: z.boolean().default(true),
        }),
        result: z.strictObject({
            dryRun: z.boolean(),
            changed: z.boolean(),
            presetNames: z.array(z.string()),
            maxDepth: z.number().int(),
        }),
    },
    'logs.query': {
        ...commandPolicy('server', 'read', ['diagnostics.read']),
        params: logQueryParametersSchema,
        result: logQueryResultSchema,
    },
    'diagnostics.snapshot': {
        ...commandPolicy('server', 'read', ['diagnostics.read']),
        params: noParameters,
        result: diagnosticsSnapshotSchema,
    },
    'events.query': {
        ...commandPolicy('server', 'read', ['events.read']),
        params: eventRecoveryRequestSchema,
        result: observableEventRecoverySchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const businessInternalMethods = {
    'project.queryForPrincipal': {
        ...commandPolicy('server', 'read'),
        params: z.object({ query: projectQuerySchema, principal: principalSchema }),
        result: projectQueryResultSchema,
    },
    'session.queryForPrincipal': {
        ...commandPolicy('server', 'read'),
        params: z.object({ query: sessionQuerySchema, principal: principalSchema }),
        result: sessionQueryResultSchema,
    },
    'terminal.queryForPrincipal': {
        ...commandPolicy('server', 'read'),
        params: z.object({ query: terminalQuerySchema, principal: principalSchema }),
        result: terminalQueryResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type ProjectQuery = z.infer<typeof projectQuerySchema>;
export type SessionQuery = z.infer<typeof sessionQuerySchema>;
export type TerminalQuery = z.infer<typeof terminalQuerySchema>;
export type ProjectQueryResult = z.infer<typeof projectQueryResultSchema>;
export type SessionQueryResult = z.infer<typeof sessionQueryResultSchema>;
export type TerminalQueryResult = z.infer<typeof terminalQueryResultSchema>;
export type SettingsPatchChange = z.infer<typeof settingsPatchChangeSchema>;
export type SettingsPatchResult = z.infer<typeof settingsPatchResultSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported by apps/server/src/domains/introspection/logs.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type LogQueryParams = z.infer<typeof logQueryParametersSchema>;
export type LogQueryRecord = z.infer<typeof logQueryRecordSchema>;
export type LogQueryResult = z.infer<typeof logQueryResultSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type LogProcess = z.infer<typeof logProcessSchema>;

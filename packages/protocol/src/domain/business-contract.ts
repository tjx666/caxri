import { z } from 'zod';

import { appSettingsSchema } from '../configuration/settings-schema.js';
import { projectListForPrincipal, projectListResultSchema } from '../registry/projections.js';
import { observableEventRecoverySchema } from '../transport/event-journal.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import { principalSchema } from '../transport/principal.js';
import { protocolVersionSchema } from '../transport/version.js';
import {
    identifierSchema,
    projectRecordSchema,
    sessionRecordSchema,
    terminalRecordSchema,
} from './domain.js';

const noParameters = z.object({}).default({});
const principalViewSchema = z.enum(['desktop', 'human-cli', 'agent', 'paired-device']);
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

const humanProjectSchema = projectRecordSchema.pick({
    id: true,
    displayTitle: true,
    rootPath: true,
});
const scopedProjectSchema = projectRecordSchema.pick({ id: true, displayTitle: true });
export const projectQueryResultSchema = z.union([
    z.object({
        view: z.enum(['desktop', 'human-cli']),
        projects: z.array(humanProjectSchema).max(1_024),
    }),
    z.object({
        view: z.enum(['agent', 'paired-device']),
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
});
export const terminalQueryResultSchema = z.object({
    view: principalViewSchema,
    terminals: z.array(terminalSummarySchema).max(8_192),
});

export const inspectableSettingsSchema = appSettingsSchema.pick({
    'session.defaultAgent': true,
    'workbench.newWorktreeBehavior': true,
    'terminal.fontSize': true,
    'terminal.scrollback': true,
    'terminal.copyOnSelect': true,
    'terminal.gpuAcceleration': true,
    'terminal.osc52ClipboardWrite': true,
    'files.maxFileBytes': true,
});
export const settingsPatchKeySchema = z.enum([
    'session.defaultAgent',
    'workbench.newWorktreeBehavior',
    'terminal.fontSize',
    'terminal.scrollback',
    'terminal.copyOnSelect',
    'terminal.gpuAcceleration',
    'terminal.osc52ClipboardWrite',
    'files.maxFileBytes',
]);
/**
 * Patch values reuse the bounded field schemas from `appSettingsSchema` with the `.default()` stripped: a patch must
 * always carry an explicit value, never silently fall back to the default.
 */
export const settingsPatchChangeSchema = z.discriminatedUnion('key', [
    z.object({
        key: z.literal('session.defaultAgent'),
        value: appSettingsSchema.shape['session.defaultAgent'].removeDefault(),
    }),
    z.object({
        key: z.literal('workbench.newWorktreeBehavior'),
        value: appSettingsSchema.shape['workbench.newWorktreeBehavior'].removeDefault(),
    }),
    z.object({
        key: z.literal('terminal.fontSize'),
        value: appSettingsSchema.shape['terminal.fontSize'].removeDefault(),
    }),
    z.object({
        key: z.literal('terminal.scrollback'),
        value: appSettingsSchema.shape['terminal.scrollback'].removeDefault(),
    }),
    z.object({
        key: z.literal('terminal.copyOnSelect'),
        value: appSettingsSchema.shape['terminal.copyOnSelect'].removeDefault(),
    }),
    z.object({
        key: z.literal('terminal.gpuAcceleration'),
        value: appSettingsSchema.shape['terminal.gpuAcceleration'].removeDefault(),
    }),
    z.object({
        key: z.literal('terminal.osc52ClipboardWrite'),
        value: appSettingsSchema.shape['terminal.osc52ClipboardWrite'].removeDefault(),
    }),
    z.object({
        key: z.literal('files.maxFileBytes'),
        value: appSettingsSchema.shape['files.maxFileBytes'].removeDefault(),
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
export const logProcessSchema = z.enum(['host', 'main', 'runtime']);
export const logQueryParametersSchema = z
    .object({
        afterCursor: z.string().min(1).max(512).optional(),
        correlationId: z.string().min(1).max(200).optional(),
        event: z.string().min(1).max(200).optional(),
        level: logLevelSchema.optional(),
        limit: z.number().int().min(1).max(100).default(50),
        process: logProcessSchema.optional(),
        since: z.iso.datetime().optional(),
    })
    .default({ limit: 50 });
export const logQueryRecordSchema = z.object({
    id: identifierSchema,
    timestamp: z.iso.datetime(),
    process: logProcessSchema,
    level: logLevelSchema,
    event: z.string().min(1).max(200),
    correlationId: z.string().min(1).max(200).optional(),
    durationMs: z.number().nonnegative().optional(),
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
});

export const businessMethods = {
    'project.list': {
        ...commandPolicy('host', 'read', ['projects.read']),
        params: noParameters,
        result: projectListResultSchema,
        projectResult: projectListForPrincipal,
    },
    'project.query': {
        ...commandPolicy('host', 'read', ['projects.read']),
        params: projectQuerySchema,
        result: projectQueryResultSchema,
    },
    'session.query': {
        ...commandPolicy('host', 'read', ['sessions.read']),
        params: sessionQuerySchema,
        result: sessionQueryResultSchema,
    },
    'terminal.query': {
        ...commandPolicy('host', 'read', ['terminals.read']),
        params: terminalQuerySchema,
        result: terminalQueryResultSchema,
    },
    'settings.inspect': {
        ...commandPolicy('host', 'read', ['settings.read']),
        params: noParameters,
        result: settingsInspectionSchema,
    },
    'settings.patch': {
        ...commandPolicy('host', 'write', ['settings.write']),
        params: settingsPatchParametersSchema,
        result: settingsPatchResultSchema,
    },
    'logs.query': {
        ...commandPolicy('host', 'read', ['diagnostics.read']),
        params: logQueryParametersSchema,
        result: logQueryResultSchema,
    },
    'diagnostics.snapshot': {
        ...commandPolicy('host', 'read', ['diagnostics.read']),
        params: noParameters,
        result: diagnosticsSnapshotSchema,
    },
    'events.query': {
        ...commandPolicy('host', 'read', ['events.read']),
        params: z.object({ afterCursor: z.number().int().nonnegative() }),
        result: observableEventRecoverySchema,
    },
} as const satisfies Record<string, MethodSpec>;

export const businessInternalMethods = {
    'project.queryForPrincipal': {
        ...commandPolicy('host', 'read'),
        params: z.object({ query: projectQuerySchema, principal: principalSchema }),
        result: projectQueryResultSchema,
    },
    'session.queryForPrincipal': {
        ...commandPolicy('host', 'read'),
        params: z.object({ query: sessionQuerySchema, principal: principalSchema }),
        result: sessionQueryResultSchema,
    },
    'terminal.queryForPrincipal': {
        ...commandPolicy('host', 'read'),
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
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported by src/runtime/introspection/logs.ts, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type LogQueryParams = z.infer<typeof logQueryParametersSchema>;
export type LogQueryRecord = z.infer<typeof logQueryRecordSchema>;
export type LogQueryResult = z.infer<typeof logQueryResultSchema>;

import { z } from 'zod';

import {
    agentDispatchInternalMethods,
    agentDispatchMethods,
} from '../agent/agent-dispatch-contract.js';
import { agentEndpointMethods } from '../agent/agent-endpoint-contract.js';
import { agentInboxMethods } from '../agent/agent-inbox-contract.js';
import { agentSkillHealthSchema } from '../agent/agent-skill-contract.js';
import { businessInternalMethods, businessMethods } from '../domain/business-contract.js';
import { workbenchInternalMethods, workbenchMethods } from '../domain/workbench-contract.js';
import {
    configurationSourceSchema,
    MAX_KEYBINDINGS,
} from '../configuration/configuration-contract.js';
import { desktopHostMethods, desktopStatusResultSchema } from '../desktop/desktop-contract.js';
import { eventRecoverySchema } from '../transport/event-journal.js';
import { commandPolicy, type MethodSpec } from '../transport/method-spec.js';
import { MAX_TRUSTED_DOMAIN_LENGTH } from '../configuration/trusted-domains.js';

import {
    agentHookHealthMapSchema,
    appSettingsSchema,
    bootstrapStateSchema,
    fileDocumentSchema,
    fileEntrySchema,
    fileMutationOperationSchema,
    fileSearchModeSchema,
    fileSearchResultSchema,
    gitCommitDetailsSchema,
    gitBlameSchema,
    gitCommitPageSchema,
    gitPullRequestChangesSchema,
    gitSummarySchema,
    gitDiffDocumentSchema,
    identifierSchema,
    keybindingConflictSchema,
    keybindingSchema,
    MAX_CONFIGURABLE_FILE_BYTES,
    mutableFileEntrySchema,
    movedFileEntrySchema,
    pathSchema,
    persistedWindowStateSchema,
    projectStatusOverviewSchema,
    projectStatusSummarySchema,
    projectRecordSchema,
    sessionRecordSchema,
    sessionStateSchema,
    terminalKindSchema,
    terminalRecordSchema,
    terminalSnapshotSchema,
    terminalResourceUsageSchema,
    themeTokensSchema,
    updateStateSchema,
} from '../domain/domain.js';

export type {
    CommandEffect,
    CommandIdempotency,
    CommandOwner,
    MethodSpec,
} from '../transport/method-spec.js';

const hostRead = commandPolicy('host', 'read');
const hostWrite = commandPolicy('host', 'write');
const hostControl = commandPolicy('host', 'control');
/**
 * PTY traffic must enter adapters in transport submission order. Request fingerprints are
 * asynchronous and can reorder overlapping input before either Main or Host reaches the adapter.
 */
const terminalStreamControl = { ...hostControl, idempotency: 'none' as const };
const desktopRead = commandPolicy('desktop', 'read');
const desktopWrite = commandPolicy('desktop', 'write');
const desktopControl = commandPolicy('desktop', 'control');
const hostStatusRead = commandPolicy('host', 'read', ['host.read']);
const hostStopControl = commandPolicy('host', 'control', ['host.stop']);
const desktopEventRead = commandPolicy('host', 'read');

/**
 * Methods without required parameters still accept the preload's `{}` placeholder, and the default
 * makes `undefined` a valid input so callers may omit the argument entirely.
 */
const noParams = z.object({}).default({});
function containsReportControlCharacter(value: string): boolean {
    for (const character of value) {
        const code = character.codePointAt(0)!;
        if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
    }
    return false;
}
const bugReportText = z
    .string()
    .min(1)
    .max(48 * 1024)
    .refine(
        (value) => !containsReportControlCharacter(value),
        'Report contains control characters',
    );
const bugReportScreenshot = z.object({
    dataUrl: z
        .string()
        .startsWith('data:image/jpeg;base64,')
        .max(12 * 1024 * 1024),
    height: z.number().int().positive().max(16_384),
    width: z.number().int().positive().max(16_384),
});

/** Keeps path-browser IPC and rendering bounded while still allowing users to refine by name. */
export const MAX_FILE_BROWSE_ENTRIES = 200;

const settingsResult = z.object({ value: appSettingsSchema, source: configurationSourceSchema });
const keybindingsResult = z.object({
    value: z.array(keybindingSchema).max(MAX_KEYBINDINGS),
    source: configurationSourceSchema,
    conflicts: z.array(keybindingConflictSchema).max(MAX_KEYBINDINGS),
});
const themeResult = z.object({ value: themeTokensSchema, source: configurationSourceSchema });
const exportedFile = z.object({ path: z.string() });
const fileName = z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine(
        (name) =>
            name !== '.' &&
            name !== '..' &&
            !name.includes('/') &&
            !name.includes('\\') &&
            !name.includes('\0'),
        'File name must not contain path separators',
    );
/** Main returns this instead of a Runtime result when the user dismisses a confirmation dialog. */
const canceled = z.object({ canceled: z.literal(true) });
const externalOpenResult = z.discriminatedUnion('status', [
    z.object({ status: z.literal('opened') }),
    z.object({ status: z.literal('canceled') }),
    z.object({
        status: z.literal('rejected'),
        reason: z.enum(['invalid_url', 'unsupported_protocol', 'credentials_not_allowed']),
    }),
]);

/**
 * The single source of truth for every public command. Each entry declares its Host/Desktop owner,
 * effect, capability boundary, idempotency policy, and Zod input/output shape. Transport adapters
 * may route an entry but must never copy its application handler.
 */
export const methods = {
    ...agentDispatchMethods,
    ...agentEndpointMethods,
    ...agentInboxMethods,
    ...businessMethods,
    ...workbenchMethods,
    'app.bootstrap': { ...hostRead, params: noParams, result: bootstrapStateSchema },
    'app.records': {
        ...hostRead,
        params: z.object({
            sessionIds: z.array(identifierSchema).max(64).default([]),
            terminalIds: z.array(identifierSchema).max(64).default([]),
        }),
        result: z.object({
            sessions: z.array(sessionRecordSchema),
            terminals: z.array(terminalRecordSchema),
        }),
    },
    'app.health': {
        ...hostStatusRead,
        params: noParams,
        result: z.object({
            ready: z.boolean(),
            pid: z.number(),
            startedAt: z.number(),
            activePtyCount: z.number(),
        }),
    },
    'host.status': {
        ...hostStatusRead,
        params: noParams,
        result: z.object({
            profileId: identifierSchema,
            version: z.string().min(1).max(100),
            pid: z.number().int().positive(),
            runtimePid: z.number().int().positive().optional(),
            startedAt: z.number().int().positive(),
            clientCount: z.number().int().nonnegative(),
            activePtyCount: z.number().int().nonnegative(),
            protocolVersion: z.number().int().positive(),
            protocolCompatible: z.boolean(),
            desktop: desktopStatusResultSchema,
        }),
    },
    'host.stop': {
        ...hostStopControl,
        params: z
            .object({ confirmLivePtys: z.boolean().default(false) })
            .default({ confirmLivePtys: false }),
        result: z.object({
            stopping: z.literal(true),
            activePtyCount: z.number().int().nonnegative(),
        }),
    },
    'events.recover': {
        ...desktopEventRead,
        params: z.object({ afterCursor: z.number().int().nonnegative() }),
        result: eventRecoverySchema,
    },
    ...desktopHostMethods,
    'app.openConfigFile': {
        ...desktopControl,
        params: z.object({ kind: z.enum(['settings', 'keybindings', 'theme']) }),
        result: z.null(),
    },
    'external.open': {
        ...desktopControl,
        params: z.object({ url: z.string().min(1).max(16_384) }),
        result: externalOpenResult,
    },
    /**
     * Native "save before closing" prompt for an Editor tab with unsaved changes. It lives in Main
     * because the choice must be a modal, focus-stealing native sheet: silently discarding an
     * unsaved buffer is the one destructive Editor action the user cannot undo.
     */
    'editor.confirmDiscard': {
        ...desktopControl,
        params: z.object({ name: z.string().min(1).max(1_024) }),
        result: z.object({ choice: z.enum(['save', 'discard', 'cancel']) }),
    },
    'processExplorer.open': { ...desktopControl, params: noParams, result: z.null() },
    'dialog.selectDirectory': {
        ...desktopControl,
        params: noParams,
        result: z.string().nullable(),
    },
    'diagnostics.export': {
        ...desktopWrite,
        params: noParams,
        result: exportedFile.nullable(),
    },
    'bugReport.context': {
        ...hostRead,
        params: noParams,
        result: z.object({
            appVersion: z.string().min(1).max(100),
            architecture: z.string().min(1).max(100),
            commit: z.string().min(1).max(100),
            platform: z.string().min(1).max(100),
            recentErrorIds: z.array(z.string().min(1).max(200)).max(5),
        }),
    },
    'bugReport.captureScreenshot': {
        ...desktopControl,
        params: noParams,
        result: bugReportScreenshot,
    },
    'bugReport.send': {
        ...desktopWrite,
        params: z.object({
            report: bugReportText,
            screenshot: bugReportScreenshot.optional(),
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
    'updates.getState': { ...desktopRead, params: noParams, result: updateStateSchema },
    'updates.check': { ...desktopRead, params: noParams, result: updateStateSchema },
    'updates.download': { ...desktopWrite, params: noParams, result: updateStateSchema },
    'updates.cancel': { ...desktopControl, params: noParams, result: updateStateSchema },
    'updates.open': { ...desktopControl, params: noParams, result: updateStateSchema },
    'project.create': {
        ...desktopWrite,
        params: z.object({ rootPath: pathSchema }),
        result: projectRecordSchema,
    },
    'project.cancelCreate': {
        ...desktopControl,
        params: z.object({ rootPath: pathSchema }),
        result: z.null(),
    },
    'project.delete': {
        ...desktopWrite,
        params: z.object({ projectId: identifierSchema }),
        result: z.union([canceled, bootstrapStateSchema]),
    },
    'project.reorder': {
        ...hostWrite,
        params: z.object({
            projectId: identifierSchema,
            targetIndex: z.number().int().nonnegative(),
        }),
        result: z.array(projectRecordSchema),
    },
    'session.create': {
        ...hostWrite,
        params: z.object({ projectId: identifierSchema, defaultAgent: terminalKindSchema }),
        result: z.object({ session: sessionRecordSchema, terminal: terminalRecordSchema }),
    },
    'session.delete': {
        ...desktopWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: z.union([canceled, bootstrapStateSchema]),
    },
    'session.select': {
        ...hostWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.markRead': {
        ...hostWrite,
        params: z.object({
            sessionId: identifierSchema,
            attentionEpoch: z.number().int().nonnegative(),
        }),
        result: sessionRecordSchema,
    },
    'session.rename': {
        ...hostWrite,
        params: z.object({
            sessionId: identifierSchema,
            displayTitle: z.string().trim().min(1).max(200),
        }),
        result: sessionRecordSchema,
    },
    'session.archive': {
        ...hostWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.unarchive': {
        ...hostWrite,
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.updateState': {
        ...hostWrite,
        params: sessionStateSchema,
        result: sessionStateSchema,
    },
    'terminal.create': {
        ...hostControl,
        params: z.object({
            sessionId: identifierSchema,
            kind: terminalKindSchema,
            /** Files may request a bounded Project-local cwd; ordinary creation keeps settings. */
            cwd: pathSchema.optional(),
        }),
        result: terminalRecordSchema,
    },
    'terminal.input': {
        ...terminalStreamControl,
        params: z.object({ terminalId: identifierSchema, data: z.string().max(65_536) }),
        result: z.null(),
    },
    'terminal.resize': {
        ...terminalStreamControl,
        params: z.object({
            terminalId: identifierSchema,
            cols: z.number().int().min(2).max(1_000),
            rows: z.number().int().min(1).max(1_000),
        }),
        result: z.null(),
    },
    'terminal.close': {
        ...hostControl,
        params: z.object({ terminalId: identifierSchema }),
        result: z.null(),
    },
    'terminal.attach': {
        ...hostControl,
        params: z
            .object({
                terminalId: identifierSchema,
                cols: z.number().int().min(2).max(1_000).optional(),
                rows: z.number().int().min(1).max(1_000).optional(),
            })
            .refine((value) => (value.cols === undefined) === (value.rows === undefined), {
                message: 'Terminal attachment dimensions must be provided together',
            }),
        result: terminalSnapshotSchema.nullable(),
    },
    'terminal.detach': {
        ...hostControl,
        params: z.object({ terminalId: identifierSchema }),
        result: z.null(),
    },
    'terminal.restart': {
        ...hostControl,
        params: z.object({
            terminalId: identifierSchema,
            mode: z.enum(['resume', 'fresh']).default('resume'),
        }),
        result: terminalRecordSchema,
    },
    'terminal.snapshot': {
        ...hostRead,
        params: z.object({ terminalId: identifierSchema }),
        result: terminalSnapshotSchema.nullable(),
    },
    'terminal.runningCount': {
        ...hostRead,
        params: z.object({ sessionId: identifierSchema.optional() }).default({}),
        result: z.number(),
    },
    'terminal.resources': {
        ...hostRead,
        params: z.object({ terminalId: identifierSchema }),
        result: terminalResourceUsageSchema.nullable(),
    },
    'files.list': {
        ...hostRead,
        params: z.object({ sessionId: identifierSchema, directory: pathSchema.optional() }),
        result: z.array(fileEntrySchema),
    },
    'files.browse': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            directory: pathSchema.optional(),
            query: z.string().max(255),
        }),
        result: z.object({
            entries: z.array(fileEntrySchema).max(MAX_FILE_BROWSE_ENTRIES),
            truncated: z.boolean(),
        }),
    },
    'files.create': {
        ...hostWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            directory: pathSchema,
            name: fileName,
            kind: z.enum(['file', 'directory']).default('file'),
        }),
        result: mutableFileEntrySchema,
    },
    'files.copy': {
        ...hostWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
        }),
        result: mutableFileEntrySchema,
    },
    'files.rename': {
        ...hostWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            name: fileName,
        }),
        result: movedFileEntrySchema,
    },
    'files.move': {
        ...hostWrite,
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
            conflict: z.enum(['reject', 'rename', 'replace']).default('reject'),
        }),
        result: movedFileEntrySchema,
    },
    'files.operation.get': {
        ...hostRead,
        params: z.object({ operationId: identifierSchema }),
        result: fileMutationOperationSchema.nullable(),
    },
    'files.operation.list': {
        ...hostRead,
        params: noParams,
        result: z.array(fileMutationOperationSchema).max(256),
    },
    'files.operation.cancel': {
        ...hostControl,
        params: z.object({ operationId: identifierSchema }),
        result: fileMutationOperationSchema,
    },
    'files.operation.acknowledge': {
        ...hostWrite,
        params: z.object({ operationId: identifierSchema }),
        result: z.null(),
    },
    'files.trash': {
        ...desktopWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            /**
             * Set when an open Editor tab holds unsaved changes for this path. The Trash can only
             * restore the last bytes written to disk, so the confirmation must stop promising that
             * the item is fully recoverable.
             */
            hasUnsavedChanges: z.boolean().optional(),
        }),
        result: z.union([canceled, mutableFileEntrySchema]),
    },
    'files.read': {
        ...hostRead,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: fileDocumentSchema,
    },
    'files.write': {
        ...hostWrite,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
        }),
        result: fileDocumentSchema,
    },
    'files.search': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            mode: fileSearchModeSchema,
            query: z.string().min(1).max(256),
            caseSensitive: z.boolean().default(false),
            wholeWord: z.boolean().default(false),
            regex: z.boolean().default(false),
            include: z.string().max(512).default(''),
            exclude: z.string().max(512).default(''),
        }),
        result: fileSearchResultSchema,
    },
    'git.summary': {
        ...hostRead,
        params: z.object({ sessionId: identifierSchema }),
        result: gitSummarySchema,
    },
    'git.branches': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
        }),
        result: z.array(z.string().min(1).max(1_024)).max(1_000),
    },
    'git.switchBranch': {
        ...hostWrite,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            branch: z.string().min(1).max(1_024),
        }),
        result: z.null(),
    },
    'git.diffDocument': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.pullRequestChanges': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            refresh: z.number().int().nonnegative().default(0),
        }),
        result: gitPullRequestChangesSchema.nullable(),
    },
    'git.pullRequestDiffDocument': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.commits': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            offset: z.number().int().nonnegative().max(10_000).default(0),
            pageSize: z.number().int().min(1).max(50).default(25),
            path: pathSchema.optional(),
        }),
        result: gitCommitPageSchema,
    },
    'git.commitDetails': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            path: pathSchema.optional(),
        }),
        result: gitCommitDetailsSchema,
    },
    'git.blame': {
        ...hostRead,
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            line: z.number().int().positive().max(10_000_000),
        }),
        result: gitBlameSchema.nullable(),
    },
    'projectStatus.summary': {
        ...hostRead,
        params: z.object({ sessionId: identifierSchema }),
        result: projectStatusSummarySchema,
    },
    'projectStatus.overview': {
        ...hostRead,
        params: z.object({ sessionId: identifierSchema }),
        result: projectStatusOverviewSchema,
    },
    'settings.get': { ...hostRead, params: noParams, result: settingsResult },
    'agentHooks.get': { ...hostRead, params: noParams, result: agentHookHealthMapSchema },
    'agentSkills.get': { ...hostRead, params: noParams, result: agentSkillHealthSchema },
    'settings.update': {
        ...hostWrite,
        params: z.object({ source: configurationSourceSchema }),
        result: settingsResult,
    },
    'keybindings.get': { ...hostRead, params: noParams, result: keybindingsResult },
    'keybindings.update': {
        ...hostWrite,
        params: z.object({ source: configurationSourceSchema }),
        result: keybindingsResult,
    },
    'theme.get': { ...hostRead, params: noParams, result: themeResult },
    'theme.update': {
        ...hostWrite,
        params: z.object({ source: configurationSourceSchema }),
        result: themeResult,
    },
    'theme.import': { ...desktopWrite, params: noParams, result: themeTokensSchema.nullable() },
} as const satisfies Record<string, MethodSpec>;

/** Main-to-Runtime methods that are never reachable from the Renderer request allowlist. */
export const internalMethods = {
    ...agentDispatchInternalMethods,
    ...businessInternalMethods,
    ...workbenchInternalMethods,
    'app.windowState.get': {
        ...hostRead,
        params: noParams,
        result: persistedWindowStateSchema,
    },
    'app.windowState.update': {
        ...hostWrite,
        params: persistedWindowStateSchema,
        result: persistedWindowStateSchema,
    },
    'bugReport.deliver': {
        ...hostControl,
        params: z.object({
            pasteImage: z.boolean(),
            report: bugReportText,
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
    'config.paths': {
        ...hostRead,
        params: noParams,
        result: z.object({
            settings: z.string(),
            keybindings: z.string(),
            theme: z.string(),
        }),
    },
    'settings.trustDomain': {
        ...hostWrite,
        params: z.object({ domain: z.string().min(1).max(MAX_TRUSTED_DOMAIN_LENGTH) }),
        result: settingsResult,
    },
    'diagnostics.exportPath': {
        ...hostWrite,
        params: z.object({ destination: pathSchema }),
        result: exportedFile,
    },
    'files.authorizeTrash': {
        ...hostControl,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: mutableFileEntrySchema.extend({
            device: z.string().regex(/^\d+$/),
            inode: z.string().regex(/^\d+$/),
            root: z.object({
                path: pathSchema,
                device: z.string().regex(/^\d+$/),
                inode: z.string().regex(/^\d+$/),
            }),
        }),
    },
    'files.authorizeOpen': {
        ...hostControl,
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: mutableFileEntrySchema.extend({
            device: z.string().regex(/^\d+$/),
            inode: z.string().regex(/^\d+$/),
            root: z.object({
                path: pathSchema,
                device: z.string().regex(/^\d+$/),
                inode: z.string().regex(/^\d+$/),
            }),
        }),
    },
    'runtime.shutdown': { ...hostControl, params: noParams, result: z.null() },
    'terminal.detachAll': { ...hostControl, params: noParams, result: z.null() },
    'terminal.terminateAll': { ...hostControl, params: noParams, result: z.null() },
    'theme.importPath': {
        ...hostWrite,
        params: z.object({ path: pathSchema }),
        result: themeTokensSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type CaxriMethod = keyof typeof methods;
type InternalMethod = keyof typeof internalMethods;
export type RuntimeMethod = CaxriMethod | InternalMethod;

type DesktopMethod = {
    [M in CaxriMethod]: Extract<(typeof methods)[M]['owner'], 'desktop'> extends never ? never : M;
}[CaxriMethod];

export type HostMethod = {
    [M in CaxriMethod]: Extract<(typeof methods)[M]['owner'], 'host'> extends never ? never : M;
}[CaxriMethod];

type AllMethods = typeof methods & typeof internalMethods;

/** Parameters as a handler receives them, after Zod applied defaults and coercion. */
type MethodParams<M extends CaxriMethod> = z.infer<(typeof methods)[M]['params']>;
/** Parameters as a caller supplies them; `undefined` is allowed when the schema has a default. */
type MethodInput<M extends CaxriMethod> = z.input<(typeof methods)[M]['params']>;
export type MethodResult<M extends CaxriMethod> = z.infer<(typeof methods)[M]['result']>;

export type RuntimeMethodParams<M extends RuntimeMethod> = z.infer<AllMethods[M]['params']>;
type RuntimeMethodInput<M extends RuntimeMethod> = z.input<AllMethods[M]['params']>;
export type RuntimeMethodResult<M extends RuntimeMethod> = z.infer<AllMethods[M]['result']>;

/** Makes the params argument optional exactly when the method's schema accepts `undefined`. */
export type ParamsArg<M extends CaxriMethod> =
    undefined extends MethodInput<M> ? [params?: MethodInput<M>] : [params: MethodInput<M>];

export type RuntimeParamsArg<M extends RuntimeMethod> =
    undefined extends RuntimeMethodInput<M>
        ? [params?: RuntimeMethodInput<M>, timeoutMs?: number]
        : [params: RuntimeMethodInput<M>, timeoutMs?: number];

/** Discriminated request unions let a `switch` on `method` narrow `params` without a cast. */
export type CaxriRequest = {
    [M in CaxriMethod]: { method: M; params: MethodParams<M> };
}[CaxriMethod];

export type DesktopRequest = Extract<CaxriRequest, { method: DesktopMethod }>;
export type HostRequest = Extract<CaxriRequest, { method: HostMethod }>;
/** Compatibility name for the Electron Main adapter while ownership moves to the Host protocol. */
export type MainRequest = DesktopRequest;

export type RuntimeRequest = {
    [M in RuntimeMethod]: { method: M; params: RuntimeMethodParams<M> };
}[RuntimeMethod];

export function isCaxriMethod(value: string): value is CaxriMethod {
    return Object.hasOwn(methods, value);
}

/** Narrows a validated public request to the Main-owned portion of the method table. */
export function isDesktopRequest(request: CaxriRequest): request is DesktopRequest {
    return methods[request.method].owner === 'desktop';
}

/** Narrows a validated public request to the Host-owned portion of the method table. */
export function isHostRequest(request: CaxriRequest): request is HostRequest {
    return methods[request.method].owner === 'host';
}

/** Compatibility guard used by the current Electron adapter. */
export function isMainRequest(request: CaxriRequest): request is MainRequest {
    return isDesktopRequest(request);
}

function isInternalMethod(value: string): value is InternalMethod {
    return Object.hasOwn(internalMethods, value);
}

export function getMethodSpec(method: string): MethodSpec | undefined {
    if (isCaxriMethod(method)) return methods[method];
    if (isInternalMethod(method)) return internalMethods[method];
    return undefined;
}

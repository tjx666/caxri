import { z } from 'zod';

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
} from './domain';

export interface MethodSpec {
    owner: 'main' | 'runtime';
    params: z.ZodType;
    result: z.ZodType;
}

/**
 * Methods without required parameters still accept the preload's `{}` placeholder, and the default
 * makes `undefined` a valid input so callers may omit the argument entirely.
 */
const noParams = z.object({}).default({});
const configurationSource = z.string().max(128 * 1024);
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

const settingsResult = z.object({ value: appSettingsSchema, source: z.string() });
const keybindingsResult = z.object({
    value: z.array(keybindingSchema),
    source: z.string(),
    conflicts: z.array(keybindingConflictSchema),
});
const themeResult = z.object({ value: themeTokensSchema, source: z.string() });
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

/**
 * The single source of truth for every Renderer-callable method: which process handles it, the Zod
 * shape of its parameters, and the Zod shape of its result. `owner` records the process that
 * receives the request; Main-owned methods may still delegate part of the work to the Runtime.
 */
export const methods = {
    'app.bootstrap': { owner: 'runtime', params: noParams, result: bootstrapStateSchema },
    'app.records': {
        owner: 'runtime',
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
        owner: 'runtime',
        params: noParams,
        result: z.object({
            ready: z.boolean(),
            pid: z.number(),
            startedAt: z.number(),
            activePtyCount: z.number(),
        }),
    },
    'app.openConfigFile': {
        owner: 'main',
        params: z.object({ kind: z.enum(['settings', 'keybindings', 'theme']) }),
        result: z.null(),
    },
    'processExplorer.open': { owner: 'main', params: noParams, result: z.null() },
    'dialog.selectDirectory': {
        owner: 'main',
        params: noParams,
        result: z.string().nullable(),
    },
    'diagnostics.export': {
        owner: 'main',
        params: noParams,
        result: exportedFile.nullable(),
    },
    'bugReport.context': {
        owner: 'runtime',
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
        owner: 'main',
        params: noParams,
        result: bugReportScreenshot,
    },
    'bugReport.send': {
        owner: 'main',
        params: z.object({
            report: bugReportText,
            screenshot: bugReportScreenshot.optional(),
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
    'updates.getState': { owner: 'main', params: noParams, result: updateStateSchema },
    'updates.check': { owner: 'main', params: noParams, result: updateStateSchema },
    'updates.download': { owner: 'main', params: noParams, result: updateStateSchema },
    'updates.cancel': { owner: 'main', params: noParams, result: updateStateSchema },
    'updates.open': { owner: 'main', params: noParams, result: updateStateSchema },
    'project.create': {
        owner: 'main',
        params: z.object({ rootPath: pathSchema }),
        result: projectRecordSchema,
    },
    'project.cancelCreate': {
        owner: 'main',
        params: z.object({ rootPath: pathSchema }),
        result: z.null(),
    },
    'project.delete': {
        owner: 'main',
        params: z.object({ projectId: identifierSchema }),
        result: z.union([canceled, bootstrapStateSchema]),
    },
    'project.reorder': {
        owner: 'runtime',
        params: z.object({
            projectId: identifierSchema,
            targetIndex: z.number().int().nonnegative(),
        }),
        result: z.array(projectRecordSchema),
    },
    'session.create': {
        owner: 'runtime',
        params: z.object({ projectId: identifierSchema, defaultAgent: terminalKindSchema }),
        result: z.object({ session: sessionRecordSchema, terminal: terminalRecordSchema }),
    },
    'session.delete': {
        owner: 'main',
        params: z.object({ sessionId: identifierSchema }),
        result: z.union([canceled, bootstrapStateSchema]),
    },
    'session.select': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.markRead': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            attentionEpoch: z.number().int().nonnegative(),
        }),
        result: sessionRecordSchema,
    },
    'session.rename': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            displayTitle: z.string().trim().min(1).max(200),
        }),
        result: sessionRecordSchema,
    },
    'session.archive': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.unarchive': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema }),
        result: sessionRecordSchema,
    },
    'session.updateState': {
        owner: 'runtime',
        params: sessionStateSchema,
        result: sessionStateSchema,
    },
    'terminal.create': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            kind: terminalKindSchema,
            /** Files may request a bounded Project-local cwd; ordinary creation keeps settings. */
            cwd: pathSchema.optional(),
        }),
        result: terminalRecordSchema,
    },
    'terminal.input': {
        owner: 'runtime',
        params: z.object({ terminalId: identifierSchema, data: z.string().max(65_536) }),
        result: z.null(),
    },
    'terminal.resize': {
        owner: 'runtime',
        params: z.object({
            terminalId: identifierSchema,
            cols: z.number().int().min(2).max(1_000),
            rows: z.number().int().min(1).max(1_000),
        }),
        result: z.null(),
    },
    'terminal.close': {
        owner: 'runtime',
        params: z.object({ terminalId: identifierSchema }),
        result: z.null(),
    },
    'terminal.attach': {
        owner: 'runtime',
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
        owner: 'runtime',
        params: z.object({ terminalId: identifierSchema }),
        result: z.null(),
    },
    'terminal.restart': {
        owner: 'runtime',
        params: z.object({
            terminalId: identifierSchema,
            mode: z.enum(['resume', 'fresh']).default('resume'),
        }),
        result: terminalRecordSchema,
    },
    'terminal.snapshot': {
        owner: 'runtime',
        params: z.object({ terminalId: identifierSchema }),
        result: terminalSnapshotSchema.nullable(),
    },
    'terminal.runningCount': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema.optional() }).default({}),
        result: z.number(),
    },
    'terminal.resources': {
        owner: 'runtime',
        params: z.object({ terminalId: identifierSchema }),
        result: terminalResourceUsageSchema.nullable(),
    },
    'files.list': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema, directory: pathSchema.optional() }),
        result: z.array(fileEntrySchema),
    },
    'files.browse': {
        owner: 'runtime',
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
        owner: 'runtime',
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
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
        }),
        result: mutableFileEntrySchema,
    },
    'files.rename': {
        owner: 'runtime',
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            name: fileName,
        }),
        result: movedFileEntrySchema,
    },
    'files.move': {
        owner: 'runtime',
        params: z.object({
            operationId: identifierSchema,
            sessionId: identifierSchema,
            path: pathSchema,
            directory: pathSchema,
            conflict: z.enum(['reject', 'rename']).default('reject'),
        }),
        result: movedFileEntrySchema,
    },
    'files.operation.get': {
        owner: 'runtime',
        params: z.object({ operationId: identifierSchema }),
        result: fileMutationOperationSchema.nullable(),
    },
    'files.operation.list': {
        owner: 'runtime',
        params: noParams,
        result: z.array(fileMutationOperationSchema).max(256),
    },
    'files.operation.cancel': {
        owner: 'runtime',
        params: z.object({ operationId: identifierSchema }),
        result: fileMutationOperationSchema,
    },
    'files.operation.acknowledge': {
        owner: 'runtime',
        params: z.object({ operationId: identifierSchema }),
        result: z.null(),
    },
    'files.reveal': {
        owner: 'main',
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: z.null(),
    },
    'files.trash': {
        owner: 'main',
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: z.union([canceled, mutableFileEntrySchema]),
    },
    'files.read': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: fileDocumentSchema,
    },
    'files.write': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            content: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
        }),
        result: fileDocumentSchema,
    },
    'files.search': {
        owner: 'runtime',
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
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema }),
        result: gitSummarySchema,
    },
    'git.branches': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
        }),
        result: z.array(z.string().min(1).max(1_024)).max(1_000),
    },
    'git.switchBranch': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            branch: z.string().min(1).max(1_024),
        }),
        result: z.null(),
    },
    'git.diff': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: z.string(),
    },
    'git.diffDocument': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.pullRequestChanges': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            refresh: z.number().int().nonnegative().default(0),
        }),
        result: gitPullRequestChangesSchema.nullable(),
    },
    'git.pullRequestDiffDocument': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            path: pathSchema,
        }),
        result: gitDiffDocumentSchema,
    },
    'git.commits': {
        owner: 'runtime',
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
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            repositoryId: identifierSchema,
            sha: z.string().regex(/^[0-9a-f]{40}$/),
            path: pathSchema.optional(),
        }),
        result: gitCommitDetailsSchema,
    },
    'git.blame': {
        owner: 'runtime',
        params: z.object({
            sessionId: identifierSchema,
            path: pathSchema,
            line: z.number().int().positive().max(10_000_000),
        }),
        result: gitBlameSchema.nullable(),
    },
    'projectStatus.summary': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema }),
        result: projectStatusSummarySchema,
    },
    'projectStatus.overview': {
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema }),
        result: projectStatusOverviewSchema,
    },
    'settings.get': { owner: 'runtime', params: noParams, result: settingsResult },
    'agentHooks.get': { owner: 'runtime', params: noParams, result: agentHookHealthMapSchema },
    'settings.update': {
        owner: 'runtime',
        params: z.object({ source: configurationSource }),
        result: settingsResult,
    },
    'keybindings.get': { owner: 'runtime', params: noParams, result: keybindingsResult },
    'keybindings.update': {
        owner: 'runtime',
        params: z.object({ source: configurationSource }),
        result: keybindingsResult,
    },
    'theme.get': { owner: 'runtime', params: noParams, result: themeResult },
    'theme.update': {
        owner: 'runtime',
        params: z.object({ source: z.string().max(256 * 1024) }),
        result: themeResult,
    },
    'theme.import': { owner: 'main', params: noParams, result: themeTokensSchema.nullable() },
} as const satisfies Record<string, MethodSpec>;

/** Main-to-Runtime methods that are never reachable from the Renderer request allowlist. */
export const internalMethods = {
    'app.windowState.get': {
        owner: 'runtime',
        params: noParams,
        result: persistedWindowStateSchema,
    },
    'app.windowState.update': {
        owner: 'runtime',
        params: persistedWindowStateSchema,
        result: persistedWindowStateSchema,
    },
    'bugReport.deliver': {
        owner: 'runtime',
        params: z.object({
            pasteImage: z.boolean(),
            report: bugReportText,
            sessionId: identifierSchema,
            terminalId: identifierSchema,
        }),
        result: z.null(),
    },
    'config.paths': {
        owner: 'runtime',
        params: noParams,
        result: z.object({
            settings: z.string(),
            keybindings: z.string(),
            theme: z.string(),
        }),
    },
    'diagnostics.exportPath': {
        owner: 'runtime',
        params: z.object({ destination: pathSchema }),
        result: exportedFile,
    },
    'files.authorizeTrash': {
        owner: 'runtime',
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
        owner: 'runtime',
        params: z.object({ sessionId: identifierSchema, path: pathSchema }),
        result: mutableFileEntrySchema,
    },
    'runtime.shutdown': { owner: 'runtime', params: noParams, result: z.null() },
    'terminal.detachAll': { owner: 'runtime', params: noParams, result: z.null() },
    'terminal.terminateAll': { owner: 'runtime', params: noParams, result: z.null() },
    'theme.importPath': {
        owner: 'runtime',
        params: z.object({ path: pathSchema }),
        result: themeTokensSchema,
    },
} as const satisfies Record<string, MethodSpec>;

export type CaxriMethod = keyof typeof methods;
type InternalMethod = keyof typeof internalMethods;
export type RuntimeMethod = CaxriMethod | InternalMethod;

type MethodOwnedBy<Owner extends MethodSpec['owner']> = {
    [M in CaxriMethod]: (typeof methods)[M]['owner'] extends Owner ? M : never;
}[CaxriMethod];

type MainMethod = MethodOwnedBy<'main'>;

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

export type MainRequest = Extract<CaxriRequest, { method: MainMethod }>;

export type RuntimeRequest = {
    [M in RuntimeMethod]: { method: M; params: RuntimeMethodParams<M> };
}[RuntimeMethod];

export function isCaxriMethod(value: string): value is CaxriMethod {
    return Object.hasOwn(methods, value);
}

/** Narrows a validated public request to the Main-owned portion of the method table. */
export function isMainRequest(request: CaxriRequest): request is MainRequest {
    return methods[request.method].owner === 'main';
}

function isInternalMethod(value: string): value is InternalMethod {
    return Object.hasOwn(internalMethods, value);
}

export function getMethodSpec(method: string): MethodSpec | undefined {
    if (isCaxriMethod(method)) return methods[method];
    if (isInternalMethod(method)) return internalMethods[method];
    return undefined;
}

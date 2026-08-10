import { z } from 'zod';

import {
    agentProviderIds,
    type AgentLaunchSettings,
    type AgentProvider,
    type AgentProviderSettings,
} from '../agents';
import { inspectorModeSchema } from '../inspector';
import { workItemSchema } from '../work-item';
import { terminalLayoutSchema } from './layout';

export const MAX_CONFIGURABLE_FILE_BYTES = 16 * 1024 * 1024;

export const identifierSchema = z.string().min(1).max(200);
export const pathSchema = z.string().min(1).max(16_384);

const agentProviderSchema = z.enum(agentProviderIds);
const agentActivityStateSchema = z.enum([
    'running',
    'waiting',
    'completed',
    'failed',
    'idle',
    'unknown',
]);
const sessionTitleModeSchema = z.enum(['automatic', 'manual']);
export const terminalKindSchema = z.enum([...agentProviderIds, 'shell']);
const processStateSchema = z.enum([
    'starting',
    'running',
    'stopped',
    'dead',
    'failed',
    'interrupted',
]);

export type { AgentProvider };
export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;
export type SessionTitleMode = z.infer<typeof sessionTitleModeSchema>;
export type TerminalKind = z.infer<typeof terminalKindSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type { InspectorMode } from '../inspector';

export const projectRecordSchema = z.object({
    id: z.string(),
    rootPath: z.string(),
    displayTitle: z.string(),
    orderIndex: z.number().int().nonnegative(),
    createdAt: z.number(),
    lastOpenedAt: z.number(),
});

export const sessionRecordSchema = z.object({
    id: z.string(),
    projectId: z.string(),
    /** Project-owned root projected onto the Session read model for path-scoped services. */
    rootPath: z.string(),
    createdAt: z.number(),
    lastOpenedAt: z.number(),
    /** Archived Sessions stay durable and keep their Terminals; only active navigation hides them. */
    archivedAt: z.number().optional(),
    /** The first Agent CLI Terminal owns the Session title; Shell-only Sessions leave this empty. */
    primaryAgentTerminalId: z.string().optional(),
    lastActivityState: agentActivityStateSchema,
    layoutVersion: z.number(),
    displayTitle: z.string(),
    /** Automatic titles follow the primary Agent; manual titles are owned by the user. */
    titleMode: sessionTitleModeSchema,
});

export const terminalRecordSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    kind: terminalKindSchema,
    provider: agentProviderSchema.optional(),
    cwd: z.string(),
    title: z.string(),
    icon: z.string(),
    orderIndex: z.number(),
    layoutNodeId: z.string(),
    agentSessionId: z.string().optional(),
    lastProcessState: processStateSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
    /** Live Runtime metadata; absent when the PTY is not running. */
    processId: z.number().optional(),
});

export const terminalSnapshotSchema = z.object({
    terminalId: z.string(),
    encodingVersion: z.number(),
    lineCount: z.number(),
    byteCount: z.number(),
    payload: z.string(),
    updatedAt: z.number(),
});

const editorTabStateSchema = z.object({
    path: pathSchema,
    dirty: z.boolean(),
    /** Missing on legacy state and pinned tabs; only the one replaceable editor sets this. */
    preview: z.literal(true).optional(),
});

export const sessionStateSchema = z.object({
    sessionId: identifierSchema,
    openTabs: z.array(editorTabStateSchema).max(100),
    /** The currently focused center-pane WorkItem (Terminal or editor tab); see `resolveActiveWork`. */
    activeTab: workItemSchema.optional(),
    inspectorMode: inspectorModeSchema,
    layout: terminalLayoutSchema,
});

/**
 * Numeric bounds and defaults for the user-configurable settings below. `appSettingsSchema` stays
 * intentionally unconstrained (it only validates the wire shape); the strict per-field bounds live
 * here so `src/runtime/configuration.ts`'s Runtime-side validation schema can import them instead of
 * re-declaring the same numbers with no compiler link back to this contract.
 */
export const SETTINGS_BOUNDS = {
    'terminal.fontSize': { min: 9, max: 32, default: 13 },
    'terminal.scrollback': { min: 100, max: 10_000, default: 2_000 },
    'files.maxFileBytes': {
        min: 1_024,
        max: MAX_CONFIGURABLE_FILE_BYTES,
        default: 2 * 1024 * 1024,
    },
} as const;

/** VS Code-style defaults for file-tree visibility; dependency and build output stay visible. */
export const DEFAULT_FILES_EXCLUDE = {
    '**/.git': true,
    '**/.hg': true,
    '**/.svn': true,
    '**/.DS_Store': true,
    '**/CVS': true,
    '**/Thumbs.db': true,
} as const;

const agentLaunchSettingsSchema: z.ZodType<AgentLaunchSettings> = z.object({
    executable: z.string(),
    args: z.array(z.string()),
});

const agentProviderSettingsSchema: z.ZodType<Record<AgentProvider, AgentProviderSettings>> =
    z.record(agentProviderSchema, z.object({ launch: agentLaunchSettingsSchema }));

export const appSettingsSchema = z.object({
    'session.defaultAgent': terminalKindSchema.nullable(),
    'agents.providers': agentProviderSettingsSchema,
    'terminal.defaultWorkingDirectory': z.string().nullable(),
    'terminal.fontSize': z.number(),
    'terminal.scrollback': z.number(),
    'files.exclude': z.record(z.string(), z.boolean()),
    'files.maxFileBytes': z.number(),
});

export const persistedWindowStateSchema = z.object({
    bounds: z.object({
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().min(640).max(16_384),
        height: z.number().int().min(480).max(16_384),
    }),
    isMaximized: z.boolean(),
    isFullScreen: z.boolean(),
});

export const keybindingSchema = z.object({
    key: z.string().min(1).max(100),
    command: z.string().min(1).max(200),
});

export const keybindingConflictSchema = z.object({
    key: z.string(),
    commands: z.array(z.string()),
});

const hex = z.string().regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/);

export const themeTokensSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    source: z.enum(['builtin', 'custom', 'vscode', 'iterm2', 'warp']),
    colors: z.object({
        background: hex,
        surface: hex,
        elevated: hex,
        foreground: hex,
        muted: hex,
        border: hex,
        selection: hex,
        accent: hex,
        success: hex,
        warning: hex,
        danger: hex,
    }),
    terminal: z.object({
        background: hex,
        foreground: hex,
        cursor: hex,
        selectionBackground: hex,
        black: hex,
        red: hex,
        green: hex,
        yellow: hex,
        blue: hex,
        magenta: hex,
        cyan: hex,
        white: hex,
        brightBlack: hex,
        brightRed: hex,
        brightGreen: hex,
        brightYellow: hex,
        brightBlue: hex,
        brightMagenta: hex,
        brightCyan: hex,
        brightWhite: hex,
    }),
    editor: z.object({
        background: hex,
        foreground: hex,
        lineHighlight: hex,
        selection: hex,
        comment: hex,
        keyword: hex,
        string: hex,
        number: hex,
    }),
    warnings: z.array(z.string()),
});

export const fileEntrySchema = z.object({
    name: z.string(),
    path: z.string(),
    kind: z.enum(['file', 'directory', 'symlink']),
    size: z.number().optional(),
    gitIgnored: z.literal(true).optional(),
});

export const mutableFileEntrySchema = z.object({
    name: z.string().min(1).max(255),
    path: pathSchema,
    kind: z.enum(['file', 'directory']),
});

export const movedFileEntrySchema = mutableFileEntrySchema.extend({ previousPath: pathSchema });

const stagedMovedFileEntrySchema = movedFileEntrySchema.extend({
    device: z.string().min(1),
    inode: z.string().min(1),
});

const stagedCreatedFileEntrySchema = mutableFileEntrySchema.extend({
    device: z.string().min(1).optional(),
    inode: z.string().min(1).optional(),
});

const fileMutationPhaseSchema = z.enum(['pre_stage', 'staged', 'completed', 'failed', 'canceled']);

const fileMutationOperationBase = {
    id: identifierSchema,
    sessionId: identifierSchema,
    phase: fileMutationPhaseSchema,
    startedAt: z.number(),
    updatedAt: z.number(),
    error: z
        .object({
            code: z.string().min(1).max(64),
            message: z.string().min(1).max(1_024),
        })
        .optional(),
};

/** Durable mutation records let a Renderer reconcile file side effects after an IPC or Runtime gap. */
export const fileMutationOperationSchema = z.discriminatedUnion('kind', [
    z.object({
        ...fileMutationOperationBase,
        kind: z.literal('create'),
        input: z.object({
            directory: pathSchema,
            name: z.string().min(1).max(255),
            kind: z.enum(['file', 'directory']),
        }),
        expectedResult: stagedCreatedFileEntrySchema.optional(),
        result: mutableFileEntrySchema.optional(),
    }),
    z.object({
        ...fileMutationOperationBase,
        kind: z.literal('rename'),
        input: z.object({ path: pathSchema, name: z.string().min(1).max(255) }),
        expectedResult: stagedMovedFileEntrySchema.optional(),
        result: movedFileEntrySchema.optional(),
    }),
    z.object({
        ...fileMutationOperationBase,
        kind: z.literal('move'),
        input: z.object({
            path: pathSchema,
            directory: pathSchema,
            conflict: z.enum(['reject', 'rename']),
        }),
        expectedResult: stagedMovedFileEntrySchema.optional(),
        result: movedFileEntrySchema.optional(),
    }),
]);

export const fileChangeSchema = z.object({
    path: z.string(),
    kind: z.enum(['create', 'update', 'delete']),
});

export const fileDocumentSchema = z.object({
    path: z.string(),
    content: z.string(),
    mtimeMs: z.number(),
    size: z.number(),
});

export const fileSearchModeSchema = z.enum(['name', 'content']);

const fileSearchMatchSchema = z.object({
    path: pathSchema,
    relativePath: z.string().min(1).max(16_384),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    matchLength: z.number().int().nonnegative().max(1_024).optional(),
    preview: z.string().max(500).optional(),
    previewMatchIndex: z.number().int().nonnegative().max(500).optional(),
});

export const fileSearchResultSchema = z.object({
    mode: fileSearchModeSchema,
    matches: z.array(fileSearchMatchSchema).max(500),
    scannedFiles: z.number().int().nonnegative(),
    truncated: z.boolean(),
    canceled: z.boolean(),
});

const gitFileStatusSchema = z.object({
    path: z.string(),
    originalPath: z.string().optional(),
    index: z.string(),
    workingTree: z.string(),
    kind: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']),
});

const gitRepositorySummarySchema = z.object({
    id: z.string(),
    kind: z.enum(['primary', 'worktree', 'nested', 'submodule']),
    name: z.string(),
    rootPath: z.string(),
    branch: z.string(),
    head: z.string().optional(),
    ahead: z.number(),
    behind: z.number(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.array(gitFileStatusSchema),
});

export const gitPullRequestChangesSchema = z.object({
    repositoryId: z.string(),
    number: z.number().int().positive(),
    title: z.string().max(4_096),
    url: z.url(),
    baseRefName: z.string().min(1).max(1_024),
    headRefName: z.string().min(1).max(1_024),
    baseOid: z.string().regex(/^[0-9a-f]{40}$/),
    headOid: z.string().regex(/^[0-9a-f]{40}$/),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.array(gitFileStatusSchema).max(2_000),
});

const gitCommitSchema = z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    shortSha: z.string().min(7).max(12),
    subject: z.string().max(4_096),
    author: z.string().max(1_024),
    authoredAt: z.number().int().nonnegative(),
    decorations: z.array(z.string().max(1_024)).max(50),
    parents: z.array(z.string().regex(/^[0-9a-f]{40}$/)).max(64),
});

export const gitCommitPageSchema = z.object({
    commits: z.array(gitCommitSchema).max(50),
    nextOffset: z.number().int().nonnegative().optional(),
});

const gitCommitFileSchema = z.object({
    path: pathSchema,
    previousPath: pathSchema.optional(),
    status: z.enum([
        'modified',
        'added',
        'deleted',
        'renamed',
        'copied',
        'type-changed',
        'unknown',
    ]),
});

export const gitCommitDetailsSchema = z.object({
    commit: gitCommitSchema,
    files: z.array(gitCommitFileSchema).max(500),
    filesTruncated: z.boolean(),
});

export const gitBlameSchema = z.object({
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    author: z.string().min(1).max(1_024),
    authoredAt: z.number().int().nonnegative(),
    subject: z.string().max(4_096),
    line: z.number().int().positive(),
    uncommitted: z.boolean(),
});

export const terminalResourceUsageSchema = z.object({
    memoryMb: z.number().nonnegative(),
    childProcessCount: z.number().int().nonnegative(),
});

export const gitSummarySchema = z.object({
    isRepository: z.boolean(),
    repositories: z.array(gitRepositorySummarySchema),
    error: z.string().optional(),
});

const projectStatusStateSchema = z.enum(['success', 'failure', 'pending', 'neutral', 'unknown']);

const projectStatusCheckSchema = z.object({
    name: z.string(),
    state: projectStatusStateSchema,
    url: z.url().optional(),
    durationMs: z.number().nonnegative().optional(),
});

const projectStatusLinearIssueSchema = z.object({
    identifier: z.string(),
    title: z.string().optional(),
    url: z.url().optional(),
    state: z.string().optional(),
    stateType: z
        .enum(['backlog', 'canceled', 'completed', 'duplicate', 'started', 'triage', 'unstarted'])
        .optional(),
});

const projectStatusDeploymentSchema = z.object({
    environment: z.enum(['production', 'preview']),
    hostname: z.string(),
    state: projectStatusStateSchema,
    url: z.url(),
    createdAt: z.number().optional(),
});

const projectStatusErrorSchema = z.object({
    source: z.enum(['github', 'linear', 'vercel']),
    message: z.string(),
    hint: z.string(),
});

const projectStatusRepositorySchema = z.object({
    id: z.string(),
    kind: z.enum(['primary', 'worktree', 'nested', 'submodule']),
    name: z.string(),
    rootPath: z.string(),
    branch: z.string(),
    defaultBranch: z.string().optional(),
    githubUrl: z.url().optional(),
    branchUrl: z.url().optional(),
    pullRequest: z
        .object({
            number: z.number().int().positive(),
            title: z.string(),
            url: z.url(),
            state: projectStatusStateSchema,
            checks: z.array(projectStatusCheckSchema),
            hiddenCheckCount: z.number().int().nonnegative(),
        })
        .optional(),
    linearIssues: z.array(projectStatusLinearIssueSchema),
    deployments: z
        .object({
            url: z.url(),
            branchDeployments: z.array(projectStatusDeploymentSchema),
            production: projectStatusDeploymentSchema.optional(),
            preview: projectStatusDeploymentSchema.optional(),
        })
        .optional(),
    errors: z.array(projectStatusErrorSchema),
});

export const projectStatusSummarySchema = z.object({
    repositories: z.array(projectStatusRepositorySchema),
    refreshedAt: z.number(),
    error: z.string().optional(),
});

export const projectStatusOverviewSchema = z.object({
    repository: z
        .object({
            id: z.string(),
            branch: z.string(),
            branchUrl: z.url().optional(),
            changedFileCount: z.number().int().nonnegative(),
            additions: z.number().int().nonnegative(),
            deletions: z.number().int().nonnegative(),
            pullRequest: z
                .object({
                    number: z.number().int().positive(),
                    title: z.string(),
                    url: z.url(),
                })
                .optional(),
        })
        .optional(),
    refreshedAt: z.number(),
    error: z.string().optional(),
});

export const gitDiffDocumentSchema = z.object({
    format: z.enum(['contents', 'patch']),
    path: pathSchema,
    originalPath: pathSchema.optional(),
    original: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
    modified: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
});

export const runtimeStatusSchema = z.enum(['starting', 'ready', 'restarting', 'failed']);

const updateVersionFields = {
    currentVersion: z.string().min(1).max(64),
    version: z.string().min(1).max(64),
    fileName: z.string().min(1).max(255),
};

/** Main-owned update state exposed to the Renderer without leaking download paths or URLs. */
export const updateStateSchema = z.discriminatedUnion('status', [
    z.object({ status: z.literal('idle'), currentVersion: updateVersionFields.currentVersion }),
    z.object({ status: z.literal('checking'), currentVersion: updateVersionFields.currentVersion }),
    z.object({
        status: z.literal('unavailable'),
        currentVersion: updateVersionFields.currentVersion,
        reason: z.string().min(1).max(1_024),
    }),
    z.object({
        status: z.literal('up-to-date'),
        currentVersion: updateVersionFields.currentVersion,
    }),
    z.object({ status: z.literal('available'), ...updateVersionFields }),
    z.object({
        status: z.literal('downloading'),
        ...updateVersionFields,
        receivedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().positive().optional(),
    }),
    z.object({ status: z.literal('ready'), ...updateVersionFields }),
    z.object({
        status: z.literal('error'),
        currentVersion: updateVersionFields.currentVersion,
        action: z.enum(['check', 'download', 'open']),
        message: z.string().min(1).max(2_048),
        version: updateVersionFields.version.optional(),
        fileName: updateVersionFields.fileName.optional(),
    }),
]);

export const bootstrapStateSchema = z.object({
    projects: z.array(projectRecordSchema),
    sessions: z.array(sessionRecordSchema),
    terminals: z.array(terminalRecordSchema),
    selectedProjectId: z.string().optional(),
    selectedSessionId: z.string().optional(),
    sessionStates: z.array(sessionStateSchema),
    settings: appSettingsSchema,
    keybindings: z.array(keybindingSchema),
    keybindingConflicts: z.array(keybindingConflictSchema),
    configurationErrors: z.array(z.string()).optional(),
    theme: themeTokensSchema,
    runtime: z.object({
        status: runtimeStatusSchema,
        restartCount: z.number(),
    }),
});

export interface AgentSnapshot {
    provider: AgentProvider;
    sessionId?: string;
    title?: string;
    status: AgentActivityState;
    usage?: Array<{ label: string; value: string }>;
    observedAt: number;
    available: boolean;
    executable?: string;
    version?: string;
}
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type PersistedWindowState = z.infer<typeof persistedWindowStateSchema>;
export type Keybinding = z.infer<typeof keybindingSchema>;
export type KeybindingConflict = z.infer<typeof keybindingConflictSchema>;
export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type MutableFileEntry = z.infer<typeof mutableFileEntrySchema>;
export type MovedFileEntry = z.infer<typeof movedFileEntrySchema>;
export type FileMutationOperation = z.infer<typeof fileMutationOperationSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type FileDocument = z.infer<typeof fileDocumentSchema>;
export type FileSearchMode = z.infer<typeof fileSearchModeSchema>;
export type FileSearchMatch = z.infer<typeof fileSearchMatchSchema>;
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;
export type GitRepositorySummary = z.infer<typeof gitRepositorySummarySchema>;
export type GitSummary = z.infer<typeof gitSummarySchema>;
export type GitPullRequestChanges = z.infer<typeof gitPullRequestChangesSchema>;
export type GitCommit = z.infer<typeof gitCommitSchema>;
export type GitCommitPage = z.infer<typeof gitCommitPageSchema>;
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetails = z.infer<typeof gitCommitDetailsSchema>;
export type GitBlame = z.infer<typeof gitBlameSchema>;
export type GitDiffDocument = z.infer<typeof gitDiffDocumentSchema>;
export type TerminalResourceUsage = z.infer<typeof terminalResourceUsageSchema>;
export type ProjectStatusState = z.infer<typeof projectStatusStateSchema>;
export type ProjectStatusCheck = z.infer<typeof projectStatusCheckSchema>;
export type ProjectStatusLinearIssue = z.infer<typeof projectStatusLinearIssueSchema>;
export type ProjectStatusDeployment = z.infer<typeof projectStatusDeploymentSchema>;
export type ProjectStatusError = z.infer<typeof projectStatusErrorSchema>;
export type ProjectStatusRepository = z.infer<typeof projectStatusRepositorySchema>;
export type ProjectStatusSummary = z.infer<typeof projectStatusSummarySchema>;
export type ProjectStatusOverview = z.infer<typeof projectStatusOverviewSchema>;
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;
export type UpdateState = z.infer<typeof updateStateSchema>;

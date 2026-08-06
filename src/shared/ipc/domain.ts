import { z } from 'zod';

import { agentProviderIds, type AgentProvider } from '../agents';
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
export const terminalKindSchema = z.enum([...agentProviderIds, 'shell']);
const processStateSchema = z.enum(['starting', 'running', 'stopped', 'dead', 'failed']);
const inspectorModeSchema = z.enum(['files', 'git', 'status', 'info']);

export type { AgentProvider };
export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;
export type TerminalKind = z.infer<typeof terminalKindSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type InspectorMode = z.infer<typeof inspectorModeSchema>;

export const projectRecordSchema = z.object({
    id: z.string(),
    rootPath: z.string(),
    displayTitle: z.string(),
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
    /** The first Agent CLI Terminal owns the Session title; Shell-only Sessions leave this empty. */
    primaryAgentTerminalId: z.string().optional(),
    lastActivityState: agentActivityStateSchema,
    layoutVersion: z.number(),
    displayTitle: z.string(),
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

const editorTabStateSchema = z.object({ path: pathSchema, dirty: z.boolean() });

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

export const appSettingsSchema = z.object({
    'session.defaultAgent': terminalKindSchema.nullable(),
    'terminal.fontSize': z.number(),
    'terminal.scrollback': z.number(),
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
});

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
    files: z.array(gitFileStatusSchema),
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
            branch: z.string(),
            branchUrl: z.url().optional(),
            changedFileCount: z.number().int().nonnegative(),
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
export type FileChange = z.infer<typeof fileChangeSchema>;
export type FileDocument = z.infer<typeof fileDocumentSchema>;
export type GitFileStatus = z.infer<typeof gitFileStatusSchema>;
export type GitRepositorySummary = z.infer<typeof gitRepositorySummarySchema>;
export type GitSummary = z.infer<typeof gitSummarySchema>;
export type GitDiffDocument = z.infer<typeof gitDiffDocumentSchema>;
export type ProjectStatusState = z.infer<typeof projectStatusStateSchema>;
export type ProjectStatusCheck = z.infer<typeof projectStatusCheckSchema>;
export type ProjectStatusLinearIssue = z.infer<typeof projectStatusLinearIssueSchema>;
export type ProjectStatusDeployment = z.infer<typeof projectStatusDeploymentSchema>;
export type ProjectStatusError = z.infer<typeof projectStatusErrorSchema>;
export type ProjectStatusRepository = z.infer<typeof projectStatusRepositorySchema>;
export type ProjectStatusSummary = z.infer<typeof projectStatusSummarySchema>;
export type ProjectStatusOverview = z.infer<typeof projectStatusOverviewSchema>;
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;

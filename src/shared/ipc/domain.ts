import { z } from 'zod';

import { workItemSchema } from '../work-item';
import { terminalLayoutSchema } from './layout';

export const MAX_CONFIGURABLE_FILE_BYTES = 16 * 1024 * 1024;

export const identifierSchema = z.string().min(1).max(200);
export const pathSchema = z.string().min(1).max(16_384);

export const agentProviderSchema = z.enum(['claude', 'codex']);
export const agentActivityStateSchema = z.enum([
    'running',
    'waiting',
    'completed',
    'failed',
    'idle',
    'unknown',
]);
export const terminalKindSchema = z.enum(['claude', 'codex', 'shell']);
export const processStateSchema = z.enum(['starting', 'running', 'stopped', 'dead', 'failed']);
export const inspectorModeSchema = z.enum(['files', 'git', 'info']);

export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;
export type TerminalKind = z.infer<typeof terminalKindSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type InspectorMode = z.infer<typeof inspectorModeSchema>;

export const agentUsageEntrySchema = z.object({ label: z.string(), value: z.string() });

export const agentSnapshotSchema = z.object({
    provider: agentProviderSchema,
    sessionId: z.string().optional(),
    title: z.string().optional(),
    status: agentActivityStateSchema,
    usage: z.array(agentUsageEntrySchema).optional(),
    observedAt: z.number(),
    available: z.boolean(),
    executable: z.string().optional(),
    version: z.string().optional(),
});

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

export const editorTabStateSchema = z.object({ path: pathSchema, dirty: z.boolean() });

export const sessionStateSchema = z.object({
    sessionId: identifierSchema,
    openTabs: z.array(editorTabStateSchema).max(100),
    /** The currently focused center-pane WorkItem (Terminal or editor tab); see `resolveActiveWork`. */
    activeTab: workItemSchema.optional(),
    inspectorMode: inspectorModeSchema,
    layout: terminalLayoutSchema,
});

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

export const gitFileStatusSchema = z.object({
    path: z.string(),
    index: z.string(),
    workingTree: z.string(),
    kind: z.enum(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']),
});

export const gitRepositorySummarySchema = z.object({
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

export type AgentSnapshot = z.infer<typeof agentSnapshotSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>;
export type EditorTabState = z.infer<typeof editorTabStateSchema>;
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
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;

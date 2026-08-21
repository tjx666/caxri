import { z } from 'zod';

import type { AgentProvider } from '../agent/agents.js';
import { agentProviderIds } from '../agent/agents.js';
import { MAX_KEYBINDINGS } from '../configuration/configuration-contract.js';
import { appSettingsSchema } from '../configuration/settings-schema.js';
import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import type { CommandId } from './commands.js';
import { gitCommitSchema } from './git.js';
import { inspectorModeSchema } from './inspector.js';
import { paneLayoutSchema } from './pane-layout.js';
import { projectIconSchema } from './project-customization.js';

export * from './git.js';

export const identifierSchema = z.string().min(1).max(200);
export const pathSchema = z.string().min(1).max(16_384);
export const MAX_TERMINAL_INPUT_LENGTH = 65_536;
const TERMINAL_SEND_SEQUENCE_COMMAND_ID =
    'workbench.action.terminal.sendSequence' satisfies CommandId;

/**
 * Main returns this instead of a Runtime result when the user dismisses a confirmation dialog.
 */
export const canceledResultSchema = z.object({ canceled: z.literal(true) });

export const agentProviderSchema = z.enum(agentProviderIds);
const agentActivityStateSchema = z.enum([
    'running',
    'waiting',
    'completed',
    'failed',
    'idle',
    'unknown',
]);
const sessionAttentionKindSchema = z.enum(['waiting', 'completed', 'failed']);
const agentOperationSchema = z.enum(['compacting']);
const sessionTitleModeSchema = z.enum(['automatic', 'manual']);
export const newWorktreeBehaviorSchema = z.enum(['ask', 'continueWhenAuthorized', 'ignore']);
export const terminalKindSchema = z.enum([...agentProviderIds, 'shell']);
const processStateSchema = z.enum([
    'starting',
    'running',
    'stopped',
    'dead',
    'failed',
    'interrupted',
]);
/**
 * Distinct causes behind a `failed` Terminal, set only alongside that state. Keep this an enum of codes (not free text)
 * so the Renderer maps each one to actionable copy in `terminal-exit-presentation.ts` without trusting Runtime-authored
 * strings.
 */
const terminalFailureReasonSchema = z.enum([
    'working_directory_unavailable',
    'executable_not_found',
    'spawn_failed',
]);

export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;
export type AgentOperation = z.infer<typeof agentOperationSchema>;
export type SessionAttentionKind = z.infer<typeof sessionAttentionKindSchema>;
export type SessionTitleMode = z.infer<typeof sessionTitleModeSchema>;
export type TerminalKind = z.infer<typeof terminalKindSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type TerminalFailureReason = z.infer<typeof terminalFailureReasonSchema>;

export const projectRecordSchema = z.object({
    id: identifierSchema,
    rootPath: pathSchema,
    displayTitle: z.string(),
    orderIndex: z.number().int().nonnegative(),
    createdAt: z.number(),
    lastOpenedAt: z.number(),
    icon: projectIconSchema.optional(),
});

export const sessionRecordSchema = z.object({
    id: identifierSchema,
    /**
     * Durable owner used for Sidebar grouping, Terminal cwd, and Agent authorization.
     */
    projectId: identifierSchema,
    /**
     * Independently authorized Project currently used by Files, Editor, and Git.
     */
    workbenchProjectId: identifierSchema,
    /**
     * Workbench Project root projected onto the Session read model for path-scoped services.
     */
    rootPath: pathSchema,
    createdAt: z.number(),
    lastOpenedAt: z.number(),
    /**
     * Archived Sessions stay durable and keep their Terminals; only active navigation hides them.
     */
    archivedAt: z.number().optional(),
    /**
     * The first Agent CLI Terminal owns the Session title; Shell-only Sessions leave this empty.
     */
    primaryAgentTerminalId: identifierSchema.optional(),
    lastActivityState: agentActivityStateSchema,
    /**
     * Monotonic generation of reliable Primary Agent attention events.
     */
    attentionEpoch: z.number().int().nonnegative(),
    /**
     * Latest generation acknowledged after the Session was visibly focused.
     */
    readAttentionEpoch: z.number().int().nonnegative(),
    lastAttentionKind: sessionAttentionKindSchema.optional(),
    /**
     * Derived read-model field; SQLite stores only the two epochs above.
     */
    hasUnread: z.boolean(),
    layoutVersion: z.number(),
    displayTitle: z.string(),
    /**
     * Automatic titles follow the primary Agent; manual titles are owned by the user.
     */
    titleMode: sessionTitleModeSchema,
});

export const terminalRecordSchema = z.object({
    id: identifierSchema,
    sessionId: identifierSchema,
    kind: terminalKindSchema,
    provider: agentProviderSchema.optional(),
    cwd: pathSchema,
    title: z.string(),
    icon: z.string(),
    orderIndex: z.number(),
    agentSessionId: z.string().optional(),
    /**
     * Live Runtime-only Agent subphase. It is projected with Terminal records and is never persisted.
     */
    agentOperation: agentOperationSchema.optional(),
    lastProcessState: processStateSchema,
    /**
     * Present only when `lastProcessState` is `failed`; see `TerminalFailureReason`.
     */
    failureReason: terminalFailureReasonSchema.optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    /**
     * Live Runtime metadata; absent when the PTY is not running.
     */
    processId: z.number().optional(),
});

export const terminalSnapshotSchema = z.object({
    terminalId: z.string(),
    encodingVersion: z.number(),
    cols: z.number().int().min(2).max(1_000),
    rows: z.number().int().min(1).max(1_000),
    lineCount: z.number(),
    byteCount: z.number(),
    payload: z.string(),
    updatedAt: z.number(),
});

/**
 * A bounded read of an Agent Terminal's provider transcript file. `content` is present only when requested; `truncated`
 * marks a transcript whose head was dropped to fit the transport cap (the newest turns matter most when inspecting a
 * live agent).
 */
export const agentTranscriptSchema = z.object({
    path: pathSchema,
    exists: z.boolean(),
    content: z.string().optional(),
    truncated: z.boolean(),
});

export const sessionStateSchema = z.object({
    sessionId: identifierSchema,
    /**
     * Scopes every ordinary Editor path in this snapshot to one authorized Workbench Root.
     */
    workbenchProjectId: identifierSchema,
    /**
     * Last durable file mutation whose editor remap was applied to this atomic Session snapshot.
     */
    editorRemapOperationId: identifierSchema.optional(),
    inspectorMode: inspectorModeSchema,
    /**
     * The Workbench split tree: the single source of truth for which Terminals and documents are open, how they are
     * arranged, and which one each pane shows. Terminal processes stay Session-global; only their placement is
     * root-local, so this tree is stored per Workbench Root. See `docs/adr/0002-unified-pane-layout.md`.
     */
    paneLayout: paneLayoutSchema,
});

const agentHookHealthKindSchema = z.enum([
    'unsupported',
    'notInstalled',
    'installedPending',
    'active',
    'stale',
    'newer',
    'drifted',
    'conflict',
    'error',
]);

const agentHookHealthSchema = z.object({
    kind: agentHookHealthKindSchema,
    message: z.string().max(1_024).optional(),
});

export const agentHookHealthMapSchema = z.record(agentProviderSchema, agentHookHealthSchema);

/**
 * One authorized Project that belongs to the owning repository's linked-worktree topology.
 */
export const workbenchRootOptionSchema = z.object({
    projectId: identifierSchema,
    displayTitle: z.string().min(1).max(1_024),
    branch: z.string().min(1).max(1_024),
    owner: z.boolean(),
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

export const keybindingWhenSchema = z.enum(['terminalFocus']);

export const keybindingSchema = z
    .object({
        key: z.string().min(1).max(100),
        /**
         * Catalog IDs are `CommandId` (see `./commands.js`); unknown values stay visible as custom keybindings.
         */
        command: z.string().min(1).max(200),
        /**
         * Arbitrary JSON arguments are retained verbatim; commands with schema-level requirements validate below.
         */
        args: z.record(z.string(), z.unknown()).optional(),
        when: keybindingWhenSchema.optional(),
    })
    .superRefine((binding, context) => {
        if (binding.command !== TERMINAL_SEND_SEQUENCE_COMMAND_ID) return;
        if (!binding.args || typeof binding.args.text !== 'string') {
            context.addIssue({
                code: 'custom',
                message: 'workbench.action.terminal.sendSequence requires args.text',
                path: ['args', 'text'],
            });
            return;
        }
        if (binding.args.text.length > MAX_TERMINAL_INPUT_LENGTH)
            context.addIssue({
                code: 'too_big',
                maximum: MAX_TERMINAL_INPUT_LENGTH,
                message: `Terminal input must contain at most ${MAX_TERMINAL_INPUT_LENGTH} characters`,
                origin: 'string',
                path: ['args', 'text'],
                type: 'string',
            });
    });

export const keybindingConflictSchema = z.object({
    key: z.string(),
    commands: z.array(z.string()),
});

const hex = z.string().regex(/^#[0-9a-f]{6}([0-9a-f]{2})?$/i);

/**
 * Import-format ids only. `builtin` and `custom` are persistence sources, not import formats — they stay off this list
 * so a new parser must extend both this tuple and `themeTokenSourceIds`.
 */
export const themeImportFormatIds = ['iterm2', 'warp', 'vscode'] as const;
export type ThemeImportFormatId = (typeof themeImportFormatIds)[number];

export const themeTokenSourceIds = ['builtin', 'custom', ...themeImportFormatIds] as const;
export type ThemeTokenSource = (typeof themeTokenSourceIds)[number];

export const themeTokensSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    source: z.enum(themeTokenSourceIds),
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
    /**
     * Optional only so journals written before Workbench Roots remain recoverable.
     */
    workbenchProjectId: identifierSchema.optional(),
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

const fileNameSchema = z.string().min(1).max(255);

const fileCreateInputSchema = z.object({
    directory: pathSchema,
    name: fileNameSchema,
    kind: z.enum(['file', 'directory']),
});

const fileRenameInputSchema = z.object({ path: pathSchema, name: fileNameSchema });

const fileMoveConflictSchema = z.enum(['reject', 'rename', 'replace']);

const fileMoveInputSchema = z.object({
    path: pathSchema,
    directory: pathSchema,
    conflict: fileMoveConflictSchema,
});

/**
 * Durable mutation records let a Renderer reconcile file side effects after an IPC or Runtime gap.
 */
export const fileMutationOperationSchema = z.discriminatedUnion('kind', [
    z.object({
        ...fileMutationOperationBase,
        kind: z.literal('create'),
        input: fileCreateInputSchema,
        expectedResult: stagedCreatedFileEntrySchema.optional(),
        result: mutableFileEntrySchema.optional(),
    }),
    z.object({
        ...fileMutationOperationBase,
        kind: z.literal('rename'),
        input: fileRenameInputSchema,
        expectedResult: stagedMovedFileEntrySchema.optional(),
        result: movedFileEntrySchema.optional(),
    }),
    z.object({
        ...fileMutationOperationBase,
        kind: z.literal('move'),
        input: fileMoveInputSchema,
        expectedResult: stagedMovedFileEntrySchema.optional(),
        result: movedFileEntrySchema.optional(),
    }),
]);

export const fileChangeSchema = z.object({
    path: pathSchema,
    kind: z.enum(['create', 'update', 'delete']),
});

export const fileDocumentSchema = z.object({
    path: pathSchema,
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
    /**
     * Total added lines across the commit's text files; binary files contribute nothing.
     */
    additions: z.number().int().nonnegative(),
    /**
     * Total deleted lines across the commit's text files; binary files contribute nothing.
     */
    deletions: z.number().int().nonnegative(),
});

export const terminalResourceUsageSchema = z.object({
    memoryMb: z.number().nonnegative(),
    childProcessCount: z.number().int().nonnegative(),
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
    detailsView: z.literal('logs').optional(),
});

const projectStatusRepoSchema = z.object({
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
    repositories: z.array(projectStatusRepoSchema),
    refreshedAt: z.number(),
    error: z.string().optional(),
});

const projectStatusOverviewPullRequestSchema = z.object({
    number: z.number().int().positive(),
    title: z.string(),
    url: z.url(),
});

const projectStatusOverviewRepoSchema = z.object({
    id: z.string(),
    branch: z.string(),
    branchUrl: z.url().optional(),
    changedFileCount: z.number().int().nonnegative(),
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    pullRequest: projectStatusOverviewPullRequestSchema.optional(),
});

export const projectStatusOverviewSchema = z.object({
    repository: projectStatusOverviewRepoSchema.optional(),
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

/**
 * Main-owned update state exposed to the Renderer without leaking download paths or URLs.
 */
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
    keybindings: z.array(keybindingSchema).max(MAX_KEYBINDINGS),
    keybindingConflicts: z.array(keybindingConflictSchema).max(MAX_KEYBINDINGS),
    configurationErrors: z.array(z.string()).optional(),
    theme: themeTokensSchema,
    runtime: z.object({
        status: runtimeStatusSchema,
        restartCount: z.number(),
    }),
});

export interface AgentSnapshot {
    provider: AgentProvider;
    /**
     * Present only for a provider-owned reliable attention signal, never a process fallback.
     */
    attentionKind?: SessionAttentionKind;
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
export type AgentTranscript = z.infer<typeof agentTranscriptSchema>;
export type SessionState = z.infer<typeof sessionStateSchema>;
export type NewWorktreeBehavior = z.infer<typeof newWorktreeBehaviorSchema>;
export type WorkbenchRootOption = z.infer<typeof workbenchRootOptionSchema>;
export type AgentHookHealth = z.infer<typeof agentHookHealthSchema>;
export type AgentHookHealthMap = z.infer<typeof agentHookHealthMapSchema>;
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
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetails = z.infer<typeof gitCommitDetailsSchema>;
export type GitDiffDocument = z.infer<typeof gitDiffDocumentSchema>;
export type TerminalResourceUsage = z.infer<typeof terminalResourceUsageSchema>;
export type ProjectStatusState = z.infer<typeof projectStatusStateSchema>;
export type ProjectStatusCheck = z.infer<typeof projectStatusCheckSchema>;
export type ProjectStatusLinearIssue = z.infer<typeof projectStatusLinearIssueSchema>;
export type ProjectStatusDeployment = z.infer<typeof projectStatusDeploymentSchema>;
export type ProjectStatusError = z.infer<typeof projectStatusErrorSchema>;
// eslint-disable-next-line unicorn/name-replacements -- exported type is imported widely across src/renderer and src/runtime, which is outside this change's authorized file scope; rename requires a coordinated cross-package edit.
export type ProjectStatusRepository = z.infer<typeof projectStatusRepoSchema>;
export type ProjectStatusSummary = z.infer<typeof projectStatusSummarySchema>;
export type ProjectStatusOverview = z.infer<typeof projectStatusOverviewSchema>;
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;
export type UpdateState = z.infer<typeof updateStateSchema>;

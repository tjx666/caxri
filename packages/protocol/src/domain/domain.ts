import { z } from 'zod';

import type { AgentProvider } from '../agent/agents.js';
import { agentProviderIds } from '../agent/agents.js';
import { MAX_KEYBINDINGS } from '../configuration/configuration-contract.js';
import { appSettingsSchema } from '../configuration/settings-schema.js';
import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import type { CommandId } from './commands.js';
import { gitCommitSchema } from './git.js';
import { paneLayoutSchema } from './pane-layout.js';
import { projectIconSchema } from './project-customization.js';
import {
    extensionTreeViewStatesSchema,
    sourceControlViewStatesSchema,
    viewContainerIdSchema,
} from './views.js';

export * from './git.js';

export const identifierSchema = z.string().min(1).max(200);
export const pathSchema = z.string().min(1).max(16_384);
export const MAX_TERMINAL_INPUT_LENGTH = 65_536;
/**
 * Bounds one complete xterm input event while the private Terminal Host frame stays independently smaller.
 */
export const MAX_TERMINAL_INPUT_PAYLOAD_LENGTH = 1_048_576;
export const MAX_TERMINAL_LINK_LENGTH = 16_384;
export const MAX_TERMINAL_LINK_ROWS = 16;
export const MAX_TERMINAL_OSC_LINKS = 1_000;
export const MAX_TERMINAL_OSC_LINK_CELLS = 256 * 1_024;
export const MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS = 256 * 1_024;
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
const sessionActivityReasonSchema = z.enum([
    'created',
    'user_submission',
    'agent_started',
    'agent_waiting',
    'agent_completed',
    'agent_failed',
]);
const agentOperationSchema = z.enum(['compacting']);
const sessionTitleModeSchema = z.enum(['automatic', 'manual']);
export const newWorktreeBehaviorSchema = z.enum([
    'ask',
    'continueWhenAuthorized',
    'continueAutomatically',
    'ignore',
]);
export const terminalKindSchema = z.enum([...agentProviderIds, 'shell']);
const processStateSchema = z.enum([
    'starting',
    'running',
    'stopped',
    'dead',
    'failed',
    'interrupted',
    'suspended',
    'detached', // user hand-over to another client; unlike `suspended`, only `session.resume` relaunches it
]);
/**
 * Distinct causes behind a `failed` Terminal, set only alongside that state. Keep this an enum of codes (not free text)
 * so the Renderer maps each one to actionable copy in `terminal-exit-presentation.ts`, never Runtime-authored strings.
 */
const terminalFailureReasonSchema = z.enum([
    'working_directory_unavailable',
    'executable_not_found',
    'spawn_failed',
]);

export type AgentActivityState = z.infer<typeof agentActivityStateSchema>;
export type AgentOperation = z.infer<typeof agentOperationSchema>;
export type SessionAttentionKind = z.infer<typeof sessionAttentionKindSchema>;
export type SessionActivityReason = z.infer<typeof sessionActivityReasonSchema>;
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
    /**
     * Present only on a worktree Project Caxri auto-registered on the named owner's behalf. Such a Project keeps every
     * authorization capability but is hidden from the PrimarySidebar's top level; a root the user added themselves
     * never carries it.
     */
    ownerProjectId: identifierSchema.optional(),
});

/**
 * Whether a Project occupies a top-level slot in the PrimarySidebar. A non-null `ownerProjectId` marks a worktree Caxri
 * auto-registered on another Project's behalf: still a fully authorized Project, but a branch working location inside
 * one checkout rather than a separate project entry point, so it is presented on the Session row that works in it
 * instead. Shared here so the Renderer, the deletion fallback, and Project ordering cannot drift apart on what "visible
 * Project" means.
 */
export function isTopLevelProject(project: Pick<ProjectRecord, 'ownerProjectId'>): boolean {
    return project.ownerProjectId === undefined;
}

export const sessionRecordSchema = z.object({
    id: identifierSchema,
    /**
     * Durable owner used for PrimarySidebar grouping, Terminal cwd, and Agent authorization.
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
     * Latest meaningful Session work event. This is independent from both visit history and the Primary Agent's current
     * `lastActivityState`.
     */
    lastSessionActivityAt: z.number(),
    lastSessionActivityReason: sessionActivityReasonSchema,
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
    /**
     * Where the hosted Agent CLI reports it is working, set only when that diverges from the PTY's launch `cwd`. Claude
     * Code's built-in `EnterWorktree` moves its own session directory and relocates its transcript without touching the
     * PTY. Server Core writes this only after Git topology proved the path is a linked worktree root of the owning
     * Project's repository, and it never replaces `cwd` as the Terminal's authorized launch root.
     */
    agentCwd: pathSchema.optional(),
    /**
     * Stable semantic title. Agent metadata promotes it to the conversation title; PTY-authored window titles must not
     * replace it.
     */
    title: z.string(),
    /**
     * Optional live Shell display title reported by the PTY through OSC 0/2. Agent bindings discard this signal.
     */
    ptyTitle: z.string().optional(),
    icon: z.string(),
    orderIndex: z.number(),
    agentSessionId: z.string().optional(),
    /**
     * Live Runtime-only Agent subphase. It is projected with Terminal records and is never persisted.
     */
    agentOperation: agentOperationSchema.optional(),
    lastAgentProcessState: processStateSchema.optional(),
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

/**
 * Current durable screen encoding shared by the Server state store and Terminal Host producer.
 */
export const CURRENT_TERMINAL_SNAPSHOT_ENCODING_VERSION = 3;

export const terminalOscLinkSnapshotSchema = z.object({
    buffer: z.enum(['normal', 'alternate']),
    endCellOffset: z.number().int().nonnegative().max(3_000_000),
    endLogicalLineIndex: z.number().int().nonnegative().max(2_999),
    endLogicalLineOffset: z.number().int().min(-3_000).max(-1),
    fingerprint: z.string().regex(/^\d{1,5}:\d{1,10}$/u),
    startCellOffset: z.number().int().nonnegative().max(3_000_000),
    startLogicalLineIndex: z.number().int().nonnegative().max(2_999),
    startLogicalLineOffset: z.number().int().min(-3_000).max(-1),
    target: z.string().min(1).max(MAX_TERMINAL_LINK_LENGTH),
});

const terminalOscLinkSnapshotsSchema = z
    .array(terminalOscLinkSnapshotSchema)
    .max(MAX_TERMINAL_OSC_LINKS)
    .refine(
        (links) =>
            links.reduce((characters, link) => characters + link.target.length, 0) <=
            MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS,
        `Terminal OSC link targets must contain at most ${MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS} characters`,
    );

export const terminalSnapshotSchema = z.object({
    terminalId: z.string(),
    encodingVersion: z.number(),
    cols: z.number().int().min(2).max(1_000),
    rows: z.number().int().min(1).max(1_000),
    lineCount: z.number(),
    byteCount: z.number(),
    payload: z.string(),
    /**
     * Runtime-authoritative OSC 8 targets for the serialized normal and active alternate buffers. SerializeAddon
     * preserves the visible cells but not their hyperlink identities, so the Renderer restores this bounded metadata
     * during the same replay.
     */
    oscLinks: terminalOscLinkSnapshotsSchema.optional(),
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
    /**
     * The user's durable intent. Availability is resolved against the Host catalog in the Renderer; unknown extension
     * IDs remain valid so a temporarily missing extension can reclaim the selection when it returns.
     */
    desiredSecondarySidebarViewContainerId: viewContainerIdSchema,
    /**
     * Bounded stable-id state for extension trees, scoped by Session, Workbench Root, and View.
     */
    extensionTreeViewStates: extensionTreeViewStatesSchema.optional(),
    /**
     * Bounded disclosure and mode state for Source Control views, scoped by Session and Workbench Root.
     */
    sourceControlViewStates: sourceControlViewStatesSchema.optional(),
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
        merged: hex, // landed work; DESIGN.md owns the role, `upgradeThemeColors` backfills older files
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
    /**
     * What a `symlink` entry points at, so the Renderer can show a folder or typed file icon instead of an untyped
     * placeholder. `broken` covers an unresolvable target. Absent on every other kind.
     */
    linkKind: z.enum(['file', 'directory', 'broken']).optional(),
    /**
     * The raw, unresolved `readlink` value of a `symlink` entry, shown in its tooltip. Never resolved against the
     * Project root: Caxri deliberately refuses to browse through symlinks, so this is display metadata only.
     */
    linkTarget: z.string().optional(),
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

/**
 * Canonical newest-first Session Activity order. The ID comparison avoids locale-dependent fallbacks for records whose
 * logical clocks and creation timestamps are equal.
 */
export function compareSessionActivityRecency(left: SessionRecord, right: SessionRecord): number {
    return (
        right.lastSessionActivityAt - left.lastSessionActivityAt ||
        right.createdAt - left.createdAt ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
}

export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>;
export type TerminalOscLinkSnapshot = z.infer<typeof terminalOscLinkSnapshotSchema>;
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
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetails = z.infer<typeof gitCommitDetailsSchema>;
export type GitDiffDocument = z.infer<typeof gitDiffDocumentSchema>;
export type TerminalResourceUsage = z.infer<typeof terminalResourceUsageSchema>;
export type BootstrapState = z.infer<typeof bootstrapStateSchema>;
export type UpdateState = z.infer<typeof updateStateSchema>;

import { z } from 'zod';

import type { AgentProvider } from '../agent/agents.js';
import { agentProviderIds } from '../agent/agents.js';
import { MAX_CONFIGURABLE_FILE_BYTES } from '../configuration/settings-spec.js';
import { MAX_SHORTCUT_CHORDS, splitShortcutChords } from '../configuration/shortcuts.js';
import type { CommandId } from './commands.js';
import { gitCommitSchema, gitFileLineStatsShape } from './git.js';
import { projectIconSchema } from './project-customization.js';

export * from './git.js';
export * from './theme.js';

export const identifierSchema = z.string().min(1).max(200);
export const pathSchema = z.string().min(1).max(16_384);
export const MAX_TERMINAL_INPUT_LENGTH = 65_536;
/**
 * Allows a 1 MiB paste plus xterm's 12-character bracketed-paste envelope. The private Terminal Host frame stays
 * independently smaller and is chunked before delivery.
 */
export const MAX_TERMINAL_INPUT_PAYLOAD_LENGTH = 1_048_576 + 12;
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

/**
 * A Session-scoped, Server in-memory-only grant that auto-allows every later Claude permission request in that Session.
 * Never a durable field on `sessionRecordSchema`: it is gone after a Server restart by design, so it is projected
 * through its own read/status commands instead of the Session read model. See docs/mobile/conversation.md for the full
 * lifecycle.
 */
export const permissionAutoAllowStatusSchema = z.strictObject({
    granted: z.boolean(),
    grantedAt: z.number().int().positive().optional(),
});
export type PermissionAutoAllowStatus = z.infer<typeof permissionAutoAllowStatusSchema>;

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
    'agent_session_unavailable',
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
    /**
     * Set while the user has hidden the Project. A hidden Project keeps its Sessions and Terminal records but is absent
     * from `app.bootstrap` and `project.list`; adding the same root again clears it and restores those Sessions.
     */
    hiddenAt: z.number().optional(),
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

/**
 * What a human CLI principal sees of a Project. `project.list` and `project.query` both answer this shape, so it lives
 * here rather than beside either of them: when the two drifted, one command could distinguish a worktree Project from a
 * top-level one and the other could not.
 *
 * `ownerProjectId` is part of it because the CLI, unlike the PrimarySidebar, lists worktree Projects alongside the ones
 * the user added. Without it two rows can carry the same title with nothing to say which is which.
 */
export const humanProjectSchema = projectRecordSchema.pick({
    id: true,
    displayTitle: true,
    ownerProjectId: true,
    rootPath: true,
});

/**
 * What every non-human principal sees: an opaque id and a title, never a path.
 */
export const scopedProjectSchema = projectRecordSchema.pick({ id: true, displayTitle: true });

export const sessionRecordSchema = z.object({
    id: identifierSchema,
    /**
     * Durable owner used for PrimarySidebar grouping and Agent authorization.
     */
    projectId: identifierSchema,
    /**
     * Independently authorized Project currently used by Files, Editor, Git, and new Terminal cwd defaults.
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
    /**
     * Ascending sidebar position, changed by dragging or meaningful activity.
     */
    sidebarOrder: z.number().int(),
    lastSessionActivityReason: sessionActivityReasonSchema,
    /**
     * Archived Sessions stay durable and keep their Terminals; only active navigation hides them.
     */
    archivedAt: z.number().optional(),
    /**
     * When the user pinned this Session, and the only thing that decides whether it is pinned at all. Absent means not
     * pinned; the timestamp is what orders a pinned Session that has never been dragged.
     */
    pinnedAt: z.number().optional(),
    /**
     * Ascending position inside the Pinned group, changed by dragging. Separate from `sidebarOrder`, which keeps
     * ordering the same Session inside its own Project group: a Session is listed in both places at once, and one
     * number cannot answer for two lists.
     */
    pinnedOrder: z.number().int().optional(),
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
    /**
     * Present only on a Chat Terminal; absence means `pty`. See `isChatTerminal`.
     */
    surface: z.literal('chat').optional(),
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
    /**
     * Specific, safe launch failure copy displayed by the Terminal recovery row.
     */
    failureDetail: z.string().max(200).optional(),
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

const agentHookHealthKindSchema = z.enum([
    'unsupported',
    'notInstalled',
    'installedPending',
    'incompatible',
    'active',
    'stale',
    'drifted',
    'conflict',
    'error',
]);

const agentHookHealthSchema = z.object({
    kind: agentHookHealthKindSchema,
    message: z.string().max(1_024).optional(),
    installedSchema: z.number().int().nonnegative().optional(),
});

export const agentHookHealthMapSchema = z.record(agentProviderSchema, agentHookHealthSchema);

/**
 * A discovered worktree; display paths never grant filesystem access.
 */
export const workbenchRootOptionSchema = z
    .object({
        projectId: identifierSchema.optional(),
        worktreeId: identifierSchema,
        authorization: z.enum(['authorized', 'required']),
        rootPath: pathSchema,
        isMain: z.boolean(),
        createdAt: z.number().positive().optional(),
        displayTitle: z.string().min(1).max(1_024),
        branch: z.string().min(1).max(1_024),
        owner: z.boolean(),
        /**
         * Set when this Session's own Agent conversation named this worktree and the Session is still bound to the
         * repository's main worktree. `0` is the most recently named. It is a display hint only: the option carries no
         * more authority than any other, and an unauthorized worktree still has to be authorized to be selected.
         */
        conversationRank: z.number().int().nonnegative().optional(),
    })
    .refine(
        (option) =>
            option.authorization === 'authorized'
                ? option.projectId !== undefined
                : option.projectId === undefined,
        {
            message: 'Only authorized worktrees carry a Project ID',
        },
    );

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

/**
 * Cross-restart bounds/open state for the two Main-owned auxiliary windows, persisted together as one `app_state` row.
 * `bounds` is absent before a window has ever been positioned; only the Commander remembers `wasOpenAtQuit`, since only
 * it reopens itself at the next launch.
 */
export const auxiliaryWindowStateSchema = z.object({
    agentCommander: z.object({
        bounds: persistedWindowStateSchema.shape.bounds.optional(),
        wasOpenAtQuit: z.boolean(),
    }),
    processExplorer: z.object({
        bounds: persistedWindowStateSchema.shape.bounds.optional(),
    }),
});
export type AuxiliaryWindowState = z.infer<typeof auxiliaryWindowStateSchema>;

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
        // `cmd+k cmd+s` is one keybinding of two chords. Dispatch tracks a single pending chord, so a longer
        // sequence would silently never fire; reject it at the file boundary instead.
        if (splitShortcutChords(binding.key).length > MAX_SHORTCUT_CHORDS)
            context.addIssue({
                code: 'custom',
                message: `A keybinding may chain at most ${MAX_SHORTCUT_CHORDS} chords, for example "cmd+k cmd+s"`,
                path: ['key'],
            });
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
    // Why the listed commands cannot all work; `findKeybindingConflicts` defines each value.
    reason: z.enum(['chordPrefix', 'duplicate']),
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
     * The raw, unresolved `readlink` value shown in the tooltip. Workspace navigation authorizes the entry path and
     * follows the current target; this display metadata is never used as authority for a later request.
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
    birthtime: z.string().min(1).optional(),
    device: z.string().min(1),
    inode: z.string().min(1),
});

const stagedCreatedFileEntrySchema = mutableFileEntrySchema.extend({
    birthtime: z.string().min(1).optional(),
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
    /**
     * Dependency documents are view-only, including after tab restore or a watcher refresh.
     */
    readOnly: z.boolean().optional(),
});

/**
 * Upper bound on one previewable binary asset. Images referenced by a document are the only consumer, and a preview
 * that inlines a file larger than this would cost more than it shows; the Renderer falls back to a placeholder.
 */
export const MAX_PREVIEW_ASSET_BYTES = 8 * 1_048_576;

/**
 * Media types a preview may load. The allowlist is the type contract: the Server never echoes a caller-supplied one.
 */
export const previewAssetMediaTypes = [
    'image/apng',
    'image/avif',
    'image/bmp',
    'image/gif',
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/webp',
    'image/x-icon',
] as const;

export const previewAssetMediaTypeSchema = z.enum(previewAssetMediaTypes);

/**
 * One image read for a preview surface. Carried as base64 over the ordinary request channel so every client (Renderer
 * today, a mobile client later) reaches it the same way, without an Electron-only protocol handler.
 */
export const fileAssetSchema = z.object({
    path: pathSchema,
    mediaType: previewAssetMediaTypeSchema,
    base64: z.string().max(Math.ceil(MAX_PREVIEW_ASSET_BYTES / 3) * 4),
    size: z.number().int().nonnegative().max(MAX_PREVIEW_ASSET_BYTES),
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
    ...gitFileLineStatsShape,
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

export const gitDiffDocumentSchema = z.object({
    format: z.enum(['contents', 'patch']),
    path: pathSchema,
    originalPath: pathSchema.optional(),
    original: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
    modified: z.string().max(MAX_CONFIGURABLE_FILE_BYTES),
});

export const runtimeStatusSchema = z.enum(['starting', 'ready', 'restarting', 'failed']);

export interface AgentSnapshot {
    /**
     * Native provenance when available; an absent value must never be assumed to mean a user rename.
     */
    titleSource?: 'automatic' | 'explicit';
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

export const sessionReorderParametersSchema = z.strictObject({
    sessionId: identifierSchema,
    anchorSessionId: identifierSchema,
    placement: z.enum(['before', 'after']),
});

export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>;
export type TerminalOscLinkSnapshot = z.infer<typeof terminalOscLinkSnapshotSchema>;
export type AgentTranscript = z.infer<typeof agentTranscriptSchema>;
export type NewWorktreeBehavior = z.infer<typeof newWorktreeBehaviorSchema>;
export type WorkbenchRootOption = z.infer<typeof workbenchRootOptionSchema>;
export type AgentHookHealth = z.infer<typeof agentHookHealthSchema>;
export type AgentHookHealthMap = z.infer<typeof agentHookHealthMapSchema>;
export type PersistedWindowState = z.infer<typeof persistedWindowStateSchema>;
export type Keybinding = z.infer<typeof keybindingSchema>;
export type KeybindingConflict = z.infer<typeof keybindingConflictSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type MutableFileEntry = z.infer<typeof mutableFileEntrySchema>;
export type MovedFileEntry = z.infer<typeof movedFileEntrySchema>;
export type FileMutationOperation = z.infer<typeof fileMutationOperationSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type FileDocument = z.infer<typeof fileDocumentSchema>;
export type FileAsset = z.infer<typeof fileAssetSchema>;
export type PreviewAssetMediaType = z.infer<typeof previewAssetMediaTypeSchema>;
export type GitCommitFile = z.infer<typeof gitCommitFileSchema>;
export type GitCommitDetails = z.infer<typeof gitCommitDetailsSchema>;
export type GitDiffDocument = z.infer<typeof gitDiffDocumentSchema>;

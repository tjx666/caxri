import { z } from 'zod';

import { agentProviderIds, agentProviderSchema } from '../agent/agents.js';
import { identifierSchema, pathSchema } from './identifiers.js';
import {
    MAX_TERMINAL_LINK_LENGTH,
    MAX_TERMINAL_OSC_LINK_TARGET_CHARACTERS,
    MAX_TERMINAL_OSC_LINKS,
} from './terminal-limits.js';

/**
 * Terminal records and screen snapshots. The Terminal Host validates these on every message, so this module stays a
 * leaf: it must not import Project, Session, or settings schemas (`docs/server-footprint.md`).
 */
const agentOperationSchema = z.enum(['compacting', 'background']);
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

/**
 * Subagent summaries one Chat Terminal keeps durably (and projects on its record). Matches the in-memory task budget,
 * so a restart never shows fewer subagents than the Chat held.
 */
export const MAX_TERMINAL_SUBAGENT_SUMMARIES = 50;

/**
 * The durable, content-free summary of one native subagent a Chat Agent started: just what a sidebar row needs. It
 * mirrors the Chat task's closed `status` values but lives here so this module stays a leaf.
 */
export const terminalSubagentSummarySchema = z.strictObject({
    taskId: z.string().min(1).max(200),
    title: z.string().max(1_000),
    agentType: z.string().max(200).optional(),
    status: z.enum(['running', 'completed', 'failed', 'stopped']),
    startedAt: z.number(),
    endedAt: z.number().optional(),
});

export type TerminalSubagentSummary = z.infer<typeof terminalSubagentSummarySchema>;

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
     * Live Runtime-only Agent subphase. It is projected with Terminal records and is never persisted. `compacting`
     * summarizes the context; `background` means the main turn ended but its completion waits on background work (a
     * subagent, workflow, or monitor) that wakes the Agent again, so the Session still counts as running.
     */
    agentOperation: agentOperationSchema.optional(),
    /**
     * Present only on a Chat Terminal that has started subagents: their persisted summaries, in no particular order.
     * Projected from the `agent_chat_subagents` table when the record is read, never stored on the Terminal row, so
     * listing them starts no provider (unlike `agentChat.read`). Running ones are marked `stopped` on Server Core
     * start, because their provider process did not survive it.
     */
    subagents: z
        .array(terminalSubagentSummarySchema)
        .max(MAX_TERMINAL_SUBAGENT_SUMMARIES)
        .optional(),
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

export type AgentOperation = z.infer<typeof agentOperationSchema>;
export type TerminalKind = z.infer<typeof terminalKindSchema>;
export type ProcessState = z.infer<typeof processStateSchema>;
export type TerminalFailureReason = z.infer<typeof terminalFailureReasonSchema>;
export type TerminalRecord = z.infer<typeof terminalRecordSchema>;
export type TerminalSnapshot = z.infer<typeof terminalSnapshotSchema>;
export type TerminalOscLinkSnapshot = z.infer<typeof terminalOscLinkSnapshotSchema>;

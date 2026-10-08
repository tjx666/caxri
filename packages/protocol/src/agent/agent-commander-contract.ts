import { z } from 'zod';

import { bootstrapStateSchema } from '../domain/bootstrap.js';
import {
    identifierSchema,
    pathSchema,
    sessionRecordSchema,
    terminalKindSchema,
    terminalRecordSchema,
} from '../domain/domain.js';
import { editorNavigationTargetSchema } from '../domain/editor.js';
import {
    pullRequestUnavailableSchema,
    sessionPullRequestSchema,
} from '../domain/session-pull-request.js';
import { settingsTargetSchema } from '../domain/settings-target.js';
import { terminalFileLinkOpenResultSchema } from '../domain/terminal-file-link.js';
import type { MethodSpec } from '../transport/method-spec.js';
import { commandPolicy } from '../transport/method-spec.js';
import {
    agentDelegationFailureSchema,
    agentDelegationStatusSchema,
} from './agent-delegation-contract.js';

/**
 * Upper bound on board rows, far above any real Workbench, so one malformed database cannot produce an unbounded reply.
 */
export const MAX_COMMANDER_BOARD_ROWS = 2_000;

/**
 * The system Project, Session, and Terminal that host the Agent Commander. They are real rows so the Commander Terminal
 * reuses the ordinary PTY, Agent Endpoint, and restore machinery, but every Workbench-facing read excludes them.
 */
export const commanderIdentitySchema = z.strictObject({
    projectId: identifierSchema,
    sessionId: identifierSchema,
    terminalId: identifierSchema,
});

/**
 * Everything the Agent Commander window renders for its own Terminal: a Workbench-shaped snapshot scoped to the
 * Commander's Project, Session, and Terminal, so the ordinary Terminal pane runs against it unchanged.
 */
export const commanderSnapshotSchema = z.strictObject({
    identity: commanderIdentitySchema,
    workspacePath: pathSchema,
    workbench: bootstrapStateSchema,
});

/**
 * Board groups in display order. `attention` outranks live work for the same reason the Workbench Activity view ranks
 * it first: unread means the user (or the Commander) has something to look at.
 */
export const commanderBoardGroupIds = [
    'attention',
    'working',
    'waiting',
    'failed',
    'finished',
    'idle',
] as const;
export const commanderBoardGroupSchema = z.enum(commanderBoardGroupIds);

export const commanderBoardRowSchema = z.strictObject({
    group: commanderBoardGroupSchema,
    projectId: identifierSchema,
    projectTitle: z.string(),
    projectRoot: pathSchema,
    sessionId: identifierSchema,
    sessionTitle: z.string(),
    activityState: sessionRecordSchema.shape.lastActivityState,
    hasUnread: z.boolean(),
    lastActivityAt: z.number(),
    /**
     * The Session's primary Agent Terminal, or its first Terminal when no Agent has claimed the Session.
     */
    agent: z
        .strictObject({
            terminalId: identifierSchema,
            kind: terminalKindSchema,
            title: z.string(),
            /**
             * The Agent CLI's process state while its Shell is up, otherwise the Shell's: an Agent can exit and leave
             * its Shell running. A plain Shell Terminal always reports the Shell.
             */
            processState: terminalRecordSchema.shape.lastProcessState,
            operation: terminalRecordSchema.shape.agentOperation,
        })
        .nullable(),
    pullRequest: sessionPullRequestSchema.optional(),
    pullRequestUnavailable: pullRequestUnavailableSchema.optional(),
    /**
     * True when the Commander created this Session, which is the only kind it may delegate new tasks into.
     */
    commanderSession: z.boolean(),
    /**
     * The latest task the Commander delegated into this Session: its receipt state only, never its answer.
     */
    task: z
        .strictObject({
            delegationId: identifierSchema,
            status: agentDelegationStatusSchema,
            failure: agentDelegationFailureSchema.optional(),
            updatedAt: z.number(),
        })
        .optional(),
});

const commanderBoardProjectSchema = z.strictObject({
    id: identifierSchema,
    title: z.string(),
    rootPath: pathSchema,
});

export const commanderBoardSchema = z.strictObject({
    generatedAt: z.number(),
    /**
     * When the cached pull-request snapshot was last refreshed; the board never waits on GitHub.
     */
    pullRequestsRefreshedAt: z.number(),
    projects: z.array(commanderBoardProjectSchema).max(MAX_COMMANDER_BOARD_ROWS),
    rows: z.array(commanderBoardRowSchema).max(MAX_COMMANDER_BOARD_ROWS),
});

/**
 * Whether the Commander runs in the background, whatever window is open. `stopped` covers every state without a live
 * process: never started, stopped by the user, or not yet resumed after an app restart. The live states mirror the
 * Commander Session's Agent activity.
 */
export const commanderRunStateSchema = z.enum([
    'stopped',
    'starting',
    'working',
    'waiting',
    'idle',
]);

export const commanderStatusSchema = z.strictObject({ state: commanderRunStateSchema });

export type CommanderIdentity = z.infer<typeof commanderIdentitySchema>;
export type CommanderSnapshot = z.infer<typeof commanderSnapshotSchema>;
export type CommanderBoardGroupId = z.infer<typeof commanderBoardGroupSchema>;
export type CommanderBoardRow = z.infer<typeof commanderBoardRowSchema>;
export type CommanderBoard = z.infer<typeof commanderBoardSchema>;
export type CommanderRunState = z.infer<typeof commanderRunStateSchema>;
export type CommanderStatus = z.infer<typeof commanderStatusSchema>;

const noParameters = z.object({}).default({});

/**
 * Agent Commander methods. The Desktop owns the Commander's lifecycle; the Commander's own Agent Endpoint receives the
 * `commander` capability and may only read the board and create empty Sessions to delegate into. See
 * `docs/agent-commander.md`.
 */
export const commanderMethods = {
    /**
     * Idempotently creates the Commander workspace, system Project, Session, and Codex Terminal, launching the Terminal
     * only when it was just created. An existing exited Terminal is left for the pane's own Resume action.
     */
    'commander.ensure': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: commanderSnapshotSchema,
    },
    'commander.snapshot': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: commanderSnapshotSchema.nullable(),
    },
    /**
     * Content-free run state for the Workbench status bar; never starts anything.
     */
    'commander.status': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: commanderStatusSchema,
    },
    /**
     * Idempotently stops the Commander Terminal's process and parks the Terminal as `detached`: its row, screen, and
     * Codex conversation stay, and the next `commander.ensure` resumes that conversation. Sessions the Commander
     * delegated into keep running; only its watch over them pauses.
     */
    'commander.stop': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: z.null(),
    },
    'commander.board': {
        ...commandPolicy('server', 'read', ['commander']),
        params: noParameters,
        result: commanderBoardSchema,
    },
    /**
     * Creates an empty Session in a visible top-level Project without changing the Workbench selection, and records it
     * as a Commander Session so the Commander may delegate into it.
     */
    'commander.session.create': {
        ...commandPolicy('server', 'control', ['commander']),
        params: z.strictObject({ projectId: identifierSchema }),
        result: z.strictObject({ projectId: identifierSchema, sessionId: identifierSchema }),
    },
    /**
     * Desktop-owned window controls: open (or raise) the Commander window, and select a Session in the Workbench and
     * focus it.
     */
    'agentCommander.open': {
        ...commandPolicy('desktop', 'control'),
        params: noParameters,
        result: z.null(),
    },
    /**
     * Closes the Commander window, if open, then stops the Commander through `commander.stop`.
     */
    'agentCommander.stop': {
        ...commandPolicy('desktop', 'control'),
        params: noParameters,
        result: z.null(),
    },
    'agentCommander.revealSession': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.null(),
    },
    /**
     * Brings the Workbench forward with Settings open. The Commander window has no Settings of its own, so its
     * Terminal's Open Settings, offered when the Agent CLI is missing, hands off here. An optional `target` scrolls
     * Settings to one specific row (see `settingsTargetSchema`) instead of landing on its default view; omitting it
     * matches the plain "Settings…" menu behavior.
     */
    'agentCommander.openSettings': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({ target: settingsTargetSchema.optional() }).default({}),
        result: z.null(),
    },
    /**
     * Opens a file link detected in the Commander Terminal, handed to the Workbench because the Commander's own Project
     * is hidden system state with no editor of its own. Main picks a real, visible Session to open it in rather than
     * trusting the Commander's own (system) Session (see `pickCommanderFileLinkSession` in
     * `workbench-root-authority.ts`), so this never grants the Commander window authority over a Project it does not
     * already have through the Workbench. `terminalId` must be the Commander's own Terminal; the Commander policy
     * validates that the same way it validates every other `TERMINAL_METHODS` request.
     */
    'agentCommander.openFileLink': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({
            terminalId: identifierSchema,
            target: z.string().min(3).max(4_096),
            location: editorNavigationTargetSchema.optional(),
        }),
        result: terminalFileLinkOpenResultSchema,
    },
} as const satisfies Record<string, MethodSpec>;

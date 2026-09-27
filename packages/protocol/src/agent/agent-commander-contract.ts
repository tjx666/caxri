import { z } from 'zod';

import { bootstrapStateSchema } from '../domain/bootstrap.js';
import {
    identifierSchema,
    pathSchema,
    sessionRecordSchema,
    terminalKindSchema,
    terminalRecordSchema,
} from '../domain/domain.js';
import {
    pullRequestUnavailableSchema,
    sessionPullRequestSchema,
} from '../domain/session-pull-request.js';
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

export type CommanderIdentity = z.infer<typeof commanderIdentitySchema>;
export type CommanderSnapshot = z.infer<typeof commanderSnapshotSchema>;
export type CommanderBoardGroupId = z.infer<typeof commanderBoardGroupSchema>;
export type CommanderBoardRow = z.infer<typeof commanderBoardRowSchema>;
export type CommanderBoard = z.infer<typeof commanderBoardSchema>;

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
    'agentCommander.revealSession': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.null(),
    },
} as const satisfies Record<string, MethodSpec>;

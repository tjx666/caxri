import { z } from 'zod';

import { bootstrapStateSchema } from '../../domain/bootstrap.js';
import { sessionRecordSchema } from '../../domain/domain.js';
import { editorNavigationTargetSchema } from '../../domain/editor.js';
import { identifierSchema, pathSchema } from '../../domain/identifiers.js';
import {
    pullRequestUnavailableSchema,
    sessionPullRequestSchema,
} from '../../domain/session-pull-request.js';
import { settingsTargetSchema } from '../../domain/settings-target.js';
import { terminalFileLinkOpenResultSchema } from '../../domain/terminal-file-link.js';
import { terminalKindSchema, terminalRecordSchema } from '../../domain/terminal-record.js';
import type { MethodSpec } from '../../transport/method-spec.js';
import { commandPolicy } from '../../transport/method-spec.js';
import {
    agentDelegationFailureSchema,
    agentDelegationStatusSchema,
} from '../delegation/agent-delegation-contract.js';
import {
    botHandoverMethods,
    botHandoverOwnershipReasonSchema,
} from './caxri-bot-handover-contract.js';
import { botInboxMethods } from './caxri-bot-inbox-contract.js';

/**
 * Upper bound on board rows, far above any real Workbench, so one malformed database cannot produce an unbounded reply.
 */
export const MAX_BOT_BOARD_ROWS = 2_000;

/**
 * The system Project, Session, and Terminal that host Caxri Bot. They are real rows so the Caxri Bot Terminal reuses
 * the ordinary PTY, Agent Endpoint, and restore machinery, but every Workbench-facing read excludes them.
 */
const botIdentitySchema = z.strictObject({
    projectId: identifierSchema,
    sessionId: identifierSchema,
    terminalId: identifierSchema,
});

/**
 * Everything the Caxri Bot window renders for its own Terminal: a Workbench-shaped snapshot scoped to the Caxri Bot's
 * Project, Session, and Terminal, so the ordinary Terminal pane runs against it unchanged.
 */
export const botSnapshotSchema = z.strictObject({
    identity: botIdentitySchema,
    workspacePath: pathSchema,
    workbench: bootstrapStateSchema,
});

/**
 * Board groups in display order. `attention` outranks live work for the same reason the Workbench Activity view ranks
 * it first: unread means the user (or Caxri Bot) has something to look at.
 */
export const botBoardGroupIds = [
    'attention',
    'working',
    'waiting',
    'failed',
    'finished',
    'idle',
] as const;
const botBoardGroupSchema = z.enum(botBoardGroupIds);

const botBoardRowSchema = z.strictObject({
    group: botBoardGroupSchema,
    projectId: identifierSchema,
    projectTitle: z.string(),
    projectRoot: pathSchema,
    sessionId: identifierSchema,
    sessionTitle: z.string(),
    activityState: sessionRecordSchema.shape.agentActivityState,
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
     * True when Caxri Bot manages this Session: it created it, or the user handed it over. These are the only Sessions
     * it may delegate new tasks into.
     */
    botSession: z.boolean(),
    /**
     * The user's hand-over of this Session, until Caxri Bot's first task continues it. `continuable` has a conversation
     * Caxri Bot can continue once its Agent is between turns; `ownership_only` has none, for the reason given, and
     * stays shown while the Session is handed over.
     */
    handover: z
        .strictObject({
            handoverId: identifierSchema,
            state: z.enum(['continuable', 'ownership_only']),
            ownershipReason: botHandoverOwnershipReasonSchema.optional(),
        })
        .optional(),
    /**
     * The latest task Caxri Bot delegated into this Session: its receipt state only, never its answer.
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

/**
 * Upper bound on Caxri Bot tasks one list returns, and on open tasks Caxri Bot may keep. Far above a real queue, so a
 * runaway loop fails with `CAPACITY` instead of growing the table without bound.
 */
export const MAX_BOT_TASKS = 500;

/**
 * Lifecycle of one Caxri Bot task. `pending` is recorded but not dispatched (often waiting on a precondition its note
 * names), `dispatched` has a delegation, `waiting_user` needs the user (a decision, or a pull request ready to merge),
 * and `done` / `dropped` are closed.
 */
export const botTaskStatuses = [
    'pending',
    'dispatched',
    'waiting_user',
    'done',
    'dropped',
] as const;
const botTaskStatusSchema = z.enum(botTaskStatuses);
export const openBotTaskStatuses: readonly BotTaskStatus[] = [
    'pending',
    'dispatched',
    'waiting_user',
];

const botTaskTitleSchema = z.string().trim().min(1).max(200);
const botTaskNoteSchema = z.string().trim().max(2_000);
const pullRequestUrlSchema = z.url({ protocol: /^https$/u }).max(2_048);

/**
 * One entry of Caxri Bot's durable task ledger. Server-owned so it survives restarts, upgrades, and context compaction
 * instead of living only in Caxri Bot's conversation. `delegationId` is the root delegation of the task: follow-ups and
 * resumes of that delegation stay on the same task.
 */
export const botTaskSchema = z.strictObject({
    id: identifierSchema,
    title: botTaskTitleSchema,
    status: botTaskStatusSchema,
    projectId: identifierSchema.nullable(),
    sessionId: identifierSchema.nullable(),
    delegationId: identifierSchema.nullable(),
    note: botTaskNoteSchema.nullable(),
    pullRequestUrl: pullRequestUrlSchema.nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const botTaskCreateSchema = z.strictObject({
    title: botTaskTitleSchema,
    status: botTaskStatusSchema.optional(),
    projectId: identifierSchema.optional(),
    note: botTaskNoteSchema.optional(),
});

/**
 * Omitted fields keep their value; `null` clears a nullable one. Linking a delegation that a task was already
 * auto-recorded for merges that automatic row into this task.
 */
const botTaskUpdateSchema = z.strictObject({
    taskId: identifierSchema,
    title: botTaskTitleSchema.optional(),
    status: botTaskStatusSchema.optional(),
    projectId: identifierSchema.nullable().optional(),
    delegationId: identifierSchema.nullable().optional(),
    note: botTaskNoteSchema.nullable().optional(),
    pullRequestUrl: pullRequestUrlSchema.nullable().optional(),
});

const botBoardProjectSchema = z.strictObject({
    id: identifierSchema,
    title: z.string(),
    rootPath: pathSchema,
});

const botBoardSchema = z.strictObject({
    generatedAt: z.number(),
    /**
     * When the cached pull-request snapshot was last refreshed; the board never waits on GitHub.
     */
    pullRequestsRefreshedAt: z.number(),
    projects: z.array(botBoardProjectSchema).max(MAX_BOT_BOARD_ROWS),
    rows: z.array(botBoardRowSchema).max(MAX_BOT_BOARD_ROWS),
    /**
     * Caxri Bot's open tasks, oldest first, so one board read also answers "what was I doing".
     */
    tasks: z.array(botTaskSchema).max(MAX_BOT_TASKS),
});

/**
 * Whether Caxri Bot runs in the background, whatever window is open. `stopped` covers every state without a live
 * process: never started, stopped by the user, or not yet resumed after an app restart. The live states mirror the
 * Caxri Bot Session's Agent activity.
 */
export const botRunStateSchema = z.enum(['stopped', 'starting', 'working', 'waiting', 'idle']);

const botStatusSchema = z.strictObject({ state: botRunStateSchema });

export type BotIdentity = z.infer<typeof botIdentitySchema>;
export type BotSnapshot = z.infer<typeof botSnapshotSchema>;
export type BotBoardGroupId = z.infer<typeof botBoardGroupSchema>;
export type BotBoardRow = z.infer<typeof botBoardRowSchema>;
export type BotBoard = z.infer<typeof botBoardSchema>;
export type BotRunState = z.infer<typeof botRunStateSchema>;
export type BotStatus = z.infer<typeof botStatusSchema>;
export type BotTaskStatus = z.infer<typeof botTaskStatusSchema>;
export type BotTask = z.infer<typeof botTaskSchema>;
export type BotTaskCreate = z.infer<typeof botTaskCreateSchema>;
export type BotTaskUpdate = z.infer<typeof botTaskUpdateSchema>;

const noParameters = z.object({}).default({});

/**
 * What `caxriBot.open` brings into view in the Caxri Bot window beyond raising it.
 */
const caxriBotOpenTargetSchema = z.enum(['inbox']);
export type CaxriBotOpenTarget = z.infer<typeof caxriBotOpenTargetSchema>;

/**
 * Caxri Bot methods. The Desktop owns Caxri Bot's lifecycle; Caxri Bot's own Agent Endpoint receives the `bot`
 * capability and may only read the board and create empty Sessions to delegate into. See `docs/caxri-bot.md`.
 */
export const botMethods = {
    /**
     * Idempotently creates Caxri Bot's workspace, system Project, Session, and Agent Terminal (the stored `BotAgent`),
     * launching the Terminal only when it was just created. An existing exited Terminal is left for the pane's own
     * Resume action.
     */
    'bot.ensure': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: botSnapshotSchema,
    },
    'bot.snapshot': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: botSnapshotSchema.nullable(),
    },
    /**
     * Content-free run state for the Workbench status bar; never starts anything.
     */
    'bot.status': {
        ...commandPolicy('server', 'read'),
        params: noParameters,
        result: botStatusSchema,
    },
    /**
     * Idempotently stops the Caxri Bot Terminal's process and parks the Terminal as `detached`: its row, screen, and
     * Agent conversation stay, and the next `bot.ensure` resumes that conversation. Sessions Caxri Bot delegated into
     * keep running; only its watch over them pauses.
     */
    'bot.stop': {
        ...commandPolicy('server', 'control'),
        params: noParameters,
        result: z.null(),
    },
    'bot.board': {
        ...commandPolicy('server', 'read', ['bot']),
        params: noParameters,
        result: botBoardSchema,
    },
    /**
     * Creates an empty Session in a visible top-level Project without changing the Workbench selection, and records it
     * as a Caxri Bot Session so Caxri Bot may delegate into it.
     */
    'bot.session.create': {
        ...commandPolicy('server', 'control', ['bot']),
        params: z.strictObject({ projectId: identifierSchema }),
        result: z.strictObject({ projectId: identifierSchema, sessionId: identifierSchema }),
    },
    /**
     * Archives one Session Caxri Bot created, the same reversible `session.archive` the sidebar runs: its Terminals and
     * Chats are parked and it leaves the Session list until the user restores it. Any other Session, including the
     * user's own and one the user handed over, is refused as `NOT_FOUND`: Caxri Bot has no control authority over
     * Sessions it did not create.
     */
    'bot.session.archive': {
        ...commandPolicy('server', 'control', ['bot']),
        params: z.strictObject({ sessionId: identifierSchema }),
        result: z.strictObject({ sessionId: identifierSchema }),
    },
    /**
     * Caxri Bot's durable task ledger. Content is Caxri Bot's own short bookkeeping (a title and a note), never a
     * delegated Agent's transcript.
     */
    'bot.task.create': {
        ...commandPolicy('server', 'control', ['bot']),
        params: botTaskCreateSchema,
        result: botTaskSchema,
    },
    'bot.task.update': {
        ...commandPolicy('server', 'control', ['bot']),
        params: botTaskUpdateSchema,
        result: botTaskSchema,
    },
    /**
     * Open tasks oldest first; `includeClosed` adds the most recently closed ones up to the list bound.
     */
    'bot.task.list': {
        ...commandPolicy('server', 'read', ['bot']),
        params: z.strictObject({ includeClosed: z.boolean().optional() }).default({}),
        result: z.strictObject({ tasks: z.array(botTaskSchema).max(MAX_BOT_TASKS) }),
    },
    /**
     * Desktop-owned window controls: open (or raise) the Caxri Bot window, and select a Session in the Workbench and
     * focus it. An optional `target` names what the raised window must show: `inbox` opens its Inbox ("Needs you"), as
     * a drawer in a narrow window, and focuses the first open item, for the status bar's `N need you` chip.
     */
    'caxriBot.open': {
        ...commandPolicy('desktop', 'control'),
        params: z.strictObject({ target: caxriBotOpenTargetSchema.optional() }).default({}),
        result: z.null(),
    },
    /**
     * Closes the Caxri Bot window, if open, then stops Caxri Bot through `bot.stop`.
     */
    'caxriBot.stop': {
        ...commandPolicy('desktop', 'control'),
        params: noParameters,
        result: z.null(),
    },
    'caxriBot.revealSession': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({ sessionId: identifierSchema }),
        result: z.null(),
    },
    /**
     * Brings the Workbench forward with Settings open. The Caxri Bot window has no Settings of its own, so its
     * Terminal's Open Settings, offered when the Agent CLI is missing, hands off here. An optional `target` scrolls
     * Settings to one specific row (see `settingsTargetSchema`) instead of landing on its default view; omitting it
     * matches the plain "Settings…" menu behavior.
     */
    'caxriBot.openSettings': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({ target: settingsTargetSchema.optional() }).default({}),
        result: z.null(),
    },
    /**
     * Opens a file link detected in the Caxri Bot Terminal, handed to the Workbench because Caxri Bot's own Project is
     * hidden system state with no editor of its own. Main picks a real, visible Session to open it in rather than
     * trusting Caxri Bot's own (system) Session (see `pickBotFileLinkSession` in `workbench-root-authority.ts`), so
     * this never grants the Caxri Bot window authority over a Project it does not already have through the Workbench.
     * `terminalId` must be Caxri Bot's own Terminal; Caxri Bot policy validates that the same way it validates every
     * other `TERMINAL_METHODS` request.
     */
    'caxriBot.openFileLink': {
        ...commandPolicy('desktop', 'control'),
        params: z.object({
            terminalId: identifierSchema,
            target: z.string().min(3).max(4_096),
            location: editorNavigationTargetSchema.optional(),
        }),
        result: terminalFileLinkOpenResultSchema,
    },
    ...botInboxMethods,
    ...botHandoverMethods,
} as const satisfies Record<string, MethodSpec>;

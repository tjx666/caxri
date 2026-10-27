import type {
    AgentDelegationReceipt,
    BotTask,
    BotTaskCreate,
    BotTaskUpdate,
} from '@caxri/protocol';
import { CaxriError, MAX_BOT_TASKS } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';

type TaskDatabase = Pick<
    CaxriDatabase,
    'caxriBotRows' | 'agentDelegations' | 'botTasks' | 'getSession' | 'listVisibleProjects'
>;

/**
 * The delegation a task is keyed by. Follow-ups and resumes record their chain's root, so every continuation of one
 * task resolves to the same row.
 */
function rootDelegationId(database: TaskDatabase, delegationId: string): string | undefined {
    const stored = database.agentDelegations.get(delegationId);
    if (!stored) return undefined;
    return stored.rootDelegationId ?? stored.receipt.delegationId;
}

/**
 * True when the receipt is a task the recorded Caxri Bot Terminal sent into a Session it created. Only those belong in
 * its ledger; an external delegation caller that targets a Caxri Bot Session does not.
 */
function isBotDelegation(database: TaskDatabase, receipt: AgentDelegationReceipt): boolean {
    const rows = database.caxriBotRows();
    return (
        rows?.terminalId !== undefined &&
        receipt.callerTerminalId === rows.terminalId &&
        rows.sessionIds.includes(receipt.sessionId)
    );
}

/**
 * Records a task for a delegation Caxri Bot started without registering one first, so the ledger never depends on Caxri
 * Bot remembering its own bookkeeping. Runs on the first receipt of a new root delegation only: follow-ups and resumes
 * already resolve to their root's task, and a later receipt must not resurrect a task Caxri Bot merged away. The title
 * is the Session title Caxri Bot chose with `--new-session --title`.
 */
export function recordBotDelegation(
    database: TaskDatabase,
    receipt: AgentDelegationReceipt,
    previous: AgentDelegationReceipt | undefined,
    now: number,
    logger?: StructuredLogger,
): void {
    if (previous || receipt.followUpOf || receipt.resumeFrom) return;
    if (!isBotDelegation(database, receipt)) return;
    if (database.botTasks.getByDelegation(receipt.delegationId)) return;
    if (database.botTasks.countOpen() >= MAX_BOT_TASKS) return;
    const sessionTitle = database.getSession(receipt.sessionId)?.title.slice(0, 200);
    const task = database.botTasks.insert(
        {
            /**
             * An empty Session title is possible in principle; a task title never is.
             */
            title: sessionTitle === undefined || sessionTitle === '' ? 'Task' : sessionTitle,
            status: 'dispatched',
            projectId: receipt.projectId,
            sessionId: receipt.sessionId,
            delegationId: receipt.delegationId,
        },
        now,
    );
    logger?.write('info', logEventCatalog.caxriBot.taskRecorded, {
        fields: { taskId: task.id, delegationId: receipt.delegationId, origin: 'delegation' },
    });
}

/**
 * Caxri Bot's durable task ledger: what it was asked to do, what it dispatched, and what is still open. It replaces the
 * hand-kept `ledger.md`, which only existed while Caxri Bot remembered to write it.
 */
export class BotTaskLedger {
    constructor(
        private readonly database: TaskDatabase,
        private readonly now: () => number,
        private readonly logger?: StructuredLogger,
    ) {}

    private assertProject(projectId: string): void {
        if (this.database.listVisibleProjects().every((project) => project.id !== projectId))
            throw new CaxriError('NOT_FOUND', 'Project is unavailable to Caxri Bot');
    }

    create(input: BotTaskCreate): BotTask {
        if (input.projectId) this.assertProject(input.projectId);
        if (this.database.botTasks.countOpen() >= MAX_BOT_TASKS)
            throw new CaxriError(
                'CAPACITY',
                `Caxri Bot already has ${MAX_BOT_TASKS} open tasks; close finished ones first`,
            );
        const task = this.database.botTasks.insert(
            {
                title: input.title,
                status: input.status ?? 'pending',
                projectId: input.projectId,
                note: input.note,
            },
            this.now(),
        );
        this.logger?.write('info', logEventCatalog.caxriBot.taskRecorded, {
            fields: { taskId: task.id, delegationId: null, origin: 'bot' },
        });
        return task;
    }

    /**
     * Linking a delegation takes its root, its Session, and that Session's Project, and moves a `pending` task to
     * `dispatched`. A task the ledger already recorded for that delegation on its own is merged into this one.
     */
    update({ taskId, delegationId, ...patch }: BotTaskUpdate): BotTask {
        const task = this.database.botTasks.get(taskId);
        if (!task) throw new CaxriError('NOT_FOUND', 'Caxri Bot task not found');
        if (patch.projectId) this.assertProject(patch.projectId);
        let link: Partial<BotTask> = {};
        if (delegationId === null) link = { delegationId: null };
        else if (delegationId !== undefined) {
            const root = rootDelegationId(this.database, delegationId);
            const receipt = root && this.database.agentDelegations.get(root)?.receipt;
            if (!root || !receipt || !isBotDelegation(this.database, receipt))
                throw new CaxriError('NOT_FOUND', 'Delegation is not one Caxri Bot sent');
            link = {
                delegationId: root,
                sessionId: receipt.sessionId,
                projectId: receipt.projectId,
                ...(task.status === 'pending' && !patch.status && { status: 'dispatched' }),
            };
        }
        const previousStatus = task.status;
        const updated = this.database.botTasks.update(taskId, { ...patch, ...link }, this.now())!;
        if (updated.status !== previousStatus)
            this.logger?.write('info', logEventCatalog.caxriBot.taskTransitioned, {
                fields: {
                    taskId,
                    from: previousStatus,
                    to: updated.status,
                    ageMs: updated.updatedAt - updated.createdAt,
                },
            });
        return updated;
    }

    list(options: { includeClosed: boolean }): BotTask[] {
        return this.database.botTasks.list(options);
    }
}

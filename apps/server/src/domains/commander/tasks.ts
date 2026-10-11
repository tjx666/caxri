import type {
    AgentDelegationReceipt,
    CommanderTask,
    CommanderTaskCreate,
    CommanderTaskUpdate,
} from '@caxri/protocol';
import { CaxriError, MAX_COMMANDER_TASKS } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { CaxriDatabase } from '../db';

type TaskDatabase = Pick<
    CaxriDatabase,
    | 'agentCommanderRows'
    | 'agentDelegations'
    | 'commanderTasks'
    | 'getSession'
    | 'listVisibleProjects'
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
 * True when the receipt is a task the recorded Commander Terminal sent into a Session it created. Only those belong in
 * its ledger; an external delegation caller that targets a Commander Session does not.
 */
function isCommanderDelegation(database: TaskDatabase, receipt: AgentDelegationReceipt): boolean {
    const rows = database.agentCommanderRows();
    return (
        rows?.terminalId !== undefined &&
        receipt.callerTerminalId === rows.terminalId &&
        rows.sessionIds.includes(receipt.sessionId)
    );
}

/**
 * Records a task for a delegation the Commander started without registering one first, so the ledger never depends on
 * the Commander remembering its own bookkeeping. Runs on the first receipt of a new root delegation only: follow-ups
 * and resumes already resolve to their root's task, and a later receipt must not resurrect a task the Commander merged
 * away. The title is the Session title the Commander chose with `--new-session --title`.
 */
export function recordCommanderDelegation(
    database: TaskDatabase,
    receipt: AgentDelegationReceipt,
    previous: AgentDelegationReceipt | undefined,
    now: number,
    logger?: StructuredLogger,
): void {
    if (previous || receipt.followUpOf || receipt.resumeFrom) return;
    if (!isCommanderDelegation(database, receipt)) return;
    if (database.commanderTasks.getByDelegation(receipt.delegationId)) return;
    if (database.commanderTasks.countOpen() >= MAX_COMMANDER_TASKS) return;
    const sessionTitle = database.getSession(receipt.sessionId)?.displayTitle.slice(0, 200);
    const task = database.commanderTasks.insert(
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
    logger?.write('info', logEventCatalog.agentCommander.taskRecorded, {
        fields: { taskId: task.id, delegationId: receipt.delegationId, origin: 'delegation' },
    });
}

/**
 * The Commander's durable task ledger: what it was asked to do, what it dispatched, and what is still open. It replaces
 * the hand-kept `ledger.md`, which only existed while the Commander remembered to write it.
 */
export class CommanderTaskLedger {
    constructor(
        private readonly database: TaskDatabase,
        private readonly now: () => number,
        private readonly logger?: StructuredLogger,
    ) {}

    private assertProject(projectId: string): void {
        if (this.database.listVisibleProjects().every((project) => project.id !== projectId))
            throw new CaxriError('NOT_FOUND', 'Project is unavailable to the Agent Commander');
    }

    create(input: CommanderTaskCreate): CommanderTask {
        if (input.projectId) this.assertProject(input.projectId);
        if (this.database.commanderTasks.countOpen() >= MAX_COMMANDER_TASKS)
            throw new CaxriError(
                'CAPACITY',
                `Agent Commander already has ${MAX_COMMANDER_TASKS} open tasks; close finished ones first`,
            );
        const task = this.database.commanderTasks.insert(
            {
                title: input.title,
                status: input.status ?? 'pending',
                projectId: input.projectId,
                note: input.note,
            },
            this.now(),
        );
        this.logger?.write('info', logEventCatalog.agentCommander.taskRecorded, {
            fields: { taskId: task.id, delegationId: null, origin: 'commander' },
        });
        return task;
    }

    /**
     * Linking a delegation takes its root, its Session, and that Session's Project, and moves a `pending` task to
     * `dispatched`. A task the ledger already recorded for that delegation on its own is merged into this one.
     */
    update({ taskId, delegationId, ...patch }: CommanderTaskUpdate): CommanderTask {
        const task = this.database.commanderTasks.get(taskId);
        if (!task) throw new CaxriError('NOT_FOUND', 'Commander task not found');
        if (patch.projectId) this.assertProject(patch.projectId);
        let link: Partial<CommanderTask> = {};
        if (delegationId === null) link = { delegationId: null };
        else if (delegationId !== undefined) {
            const root = rootDelegationId(this.database, delegationId);
            const receipt = root && this.database.agentDelegations.get(root)?.receipt;
            if (!root || !receipt || !isCommanderDelegation(this.database, receipt))
                throw new CaxriError('NOT_FOUND', 'Delegation is not one the Agent Commander sent');
            link = {
                delegationId: root,
                sessionId: receipt.sessionId,
                projectId: receipt.projectId,
                ...(task.status === 'pending' && !patch.status && { status: 'dispatched' }),
            };
        }
        const previousStatus = task.status;
        const updated = this.database.commanderTasks.update(
            taskId,
            { ...patch, ...link },
            this.now(),
        )!;
        if (updated.status !== previousStatus)
            this.logger?.write('info', logEventCatalog.agentCommander.taskTransitioned, {
                fields: {
                    taskId,
                    from: previousStatus,
                    to: updated.status,
                    ageMs: updated.updatedAt - updated.createdAt,
                },
            });
        return updated;
    }

    list(options: { includeClosed: boolean }): CommanderTask[] {
        return this.database.commanderTasks.list(options);
    }
}

import type { TerminalSubagentSummary } from '@caxri/protocol';
import { MAX_TERMINAL_SUBAGENT_SUMMARIES } from '@caxri/protocol';
import { and, eq } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { agentChatSubagents } from '../schema-agent-chat';

/**
 * A subagent as the Chat task list reports it; `startedAt` is optional because a provider may not report it, in which
 * case the row keeps the time it was first seen.
 */
export type SubagentSummaryInput = Omit<TerminalSubagentSummary, 'startedAt'> & {
    startedAt?: number;
};

function isSameSummary(left: TerminalSubagentSummary, right: TerminalSubagentSummary): boolean {
    return (
        left.title === right.title &&
        left.agentType === right.agentType &&
        left.status === right.status &&
        left.startedAt === right.startedAt &&
        left.endedAt === right.endedAt
    );
}

/**
 * Pure CRUD for `agent_chat_subagents`: the persisted subagent summaries the sidebar lists without starting a provider.
 */
export class AgentChatSubagentsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    list(terminalId: string): TerminalSubagentSummary[] {
        return this.database
            .select()
            .from(agentChatSubagents)
            .where(eq(agentChatSubagents.terminalId, terminalId))
            .all()
            .map(toSummary);
    }

    /**
     * Writes the rows of `summaries` that are new or changed, then trims the Chat to `MAX_TERMINAL_SUBAGENT_SUMMARIES`
     * (oldest ended rows first, a running one only when nothing else is left). Returns whether any row changed, which
     * is what decides if Clients are told.
     */
    sync(
        terminalId: string,
        summaries: readonly SubagentSummaryInput[],
        now = Date.now(),
    ): boolean {
        if (summaries.length === 0) return false;
        let isChanged = false;
        this.database.transaction((transaction) => {
            const existing = new Map(
                transaction
                    .select()
                    .from(agentChatSubagents)
                    .where(eq(agentChatSubagents.terminalId, terminalId))
                    .all()
                    .map((row) => [row.taskId, toSummary(row)]),
            );
            for (const input of summaries) {
                const previous = existing.get(input.taskId);
                const next: TerminalSubagentSummary = {
                    ...input,
                    startedAt: input.startedAt ?? previous?.startedAt ?? now,
                };
                if (previous && isSameSummary(previous, next)) continue;
                const values = {
                    terminalId,
                    taskId: next.taskId,
                    title: next.title,
                    agentType: next.agentType ?? null,
                    status: next.status,
                    startedAt: next.startedAt,
                    endedAt: next.endedAt ?? null,
                };
                transaction
                    .insert(agentChatSubagents)
                    .values(values)
                    .onConflictDoUpdate({
                        target: [agentChatSubagents.terminalId, agentChatSubagents.taskId],
                        set: values,
                    })
                    .run();
                existing.set(next.taskId, next);
                isChanged = true;
            }
            const overflow = existing.size - MAX_TERMINAL_SUBAGENT_SUMMARIES;
            if (overflow <= 0) return;
            const evicted = existing
                .values()
                .toArray()
                .toSorted(
                    (left, right) =>
                        Number(left.status === 'running') - Number(right.status === 'running') ||
                        (left.endedAt ?? left.startedAt) - (right.endedAt ?? right.startedAt),
                )
                .slice(0, overflow);
            for (const row of evicted)
                transaction
                    .delete(agentChatSubagents)
                    .where(
                        and(
                            eq(agentChatSubagents.terminalId, terminalId),
                            eq(agentChatSubagents.taskId, row.taskId),
                        ),
                    )
                    .run();
        });
        return isChanged;
    }

    /**
     * Rewrites every `running` row to `stopped` and returns the Terminals it touched. Server Core calls it once at
     * start: the provider processes that ran those subagents ended with the previous Server Core, so a persisted
     * `running` would otherwise show as running forever.
     */
    stopRunning(now = Date.now()): string[] {
        const stopped = this.database
            .update(agentChatSubagents)
            .set({ status: 'stopped', endedAt: now })
            .where(eq(agentChatSubagents.status, 'running'))
            .returning({ terminalId: agentChatSubagents.terminalId })
            .all();
        return [...new Set(stopped.map((row) => row.terminalId))];
    }
}

function toSummary(row: typeof agentChatSubagents.$inferSelect): TerminalSubagentSummary {
    return {
        taskId: row.taskId,
        title: row.title,
        ...(row.agentType !== null && { agentType: row.agentType }),
        status: row.status as TerminalSubagentSummary['status'],
        startedAt: row.startedAt,
        ...(row.endedAt !== null && { endedAt: row.endedAt }),
    };
}

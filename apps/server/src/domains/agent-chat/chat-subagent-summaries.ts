import type { AgentChatTask } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { chatStateStore } from './chat-state-store';

/**
 * Writes the sidebar's durable subagent summaries (`agent_chat_subagents`) as a Chat's task list changes, and tells
 * Clients when a summary field moved. A task list changes on every streamed usage or tool update, but the summary only
 * on a start, a rename, or a status change, so each Chat remembers the last summary it wrote and skips the database
 * (and the broadcast) for everything else. Shell tasks are not subagents and are never stored.
 */
export class ChatSubagentSummaries {
    private readonly written = new Map<string, Map<string, string>>();

    constructor(
        private readonly database: CaxriDatabase,
        private readonly publish: (terminalId: string) => void,
    ) {}

    record(terminalId: string, tasks: readonly AgentChatTask[] | undefined): void {
        const subagents = (tasks ?? []).filter((task) => task.kind === 'agent');
        if (subagents.length === 0) return;
        let known = this.written.get(terminalId);
        if (!known) {
            known = new Map();
            this.written.set(terminalId, known);
        }
        const changed = subagents.filter((task) => {
            const key = fingerprint(task);
            if (known.get(task.id) === key) return false;
            known.set(task.id, key);
            return true;
        });
        if (changed.length === 0) return;
        // A task update can land after its Terminal was deleted; the row would violate the foreign key.
        if (!this.database.getTerminal(terminalId)) return;
        const isStored = chatStateStore(this.database).subagents.sync(
            terminalId,
            changed.map((task) => ({
                taskId: task.id,
                title: task.title,
                ...(task.agentType !== undefined && { agentType: task.agentType }),
                status: task.status,
                ...(task.startedAt !== undefined && { startedAt: task.startedAt }),
                ...(task.endedAt !== undefined && { endedAt: task.endedAt }),
            })),
        );
        if (isStored) this.publish(terminalId);
    }

    /**
     * Drops a Chat's remembered summaries when its state is dropped, so the next projection writes afresh.
     */
    forget(terminalId: string): void {
        this.written.delete(terminalId);
    }

    /**
     * Server Core start: the provider processes that ran persisted `running` subagents ended with the previous Server
     * Core, so mark them `stopped` (a later resume overwrites it with the provider's real status). Returns the touched
     * Terminals so the caller can log the count.
     */
    reconcileOnStart(): string[] {
        return chatStateStore(this.database).subagents.stopRunning();
    }
}

function fingerprint(task: AgentChatTask): string {
    return JSON.stringify([task.title, task.agentType, task.status, task.startedAt, task.endedAt]);
}

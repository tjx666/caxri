import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import * as schema from '../schema';
import { terminals } from '../schema';
import { AgentChatAnsweredNoticesModel } from './agent-chat-answered-notices';
import { AgentChatProcessGroupsModel } from './agent-chat-process-groups';
import { AgentChatSubagentsModel } from './agent-chat-subagents';
import { AgentChatVersionsModel } from './agent-chat-versions';

/**
 * Agent Chat state that no provider history can rebuild, for the Agent Chat domain to read through the Server's open
 * SQLite handle (like `BenchmarkRunsModel`): the `Answered: ...` notices, the process groups of live provider children,
 * the subagent summaries the sidebar lists, the earlier versions "Edit from here" replaced, and a rewound Claude Chat's
 * resume point. The migration runner has already created the tables on that handle.
 */
export class AgentChatStateModel {
    private readonly database;
    readonly answeredNotices: AgentChatAnsweredNoticesModel;
    readonly processGroups: AgentChatProcessGroupsModel;
    readonly subagents: AgentChatSubagentsModel;
    readonly versions: AgentChatVersionsModel;

    constructor(connection: Database.Database) {
        this.database = drizzle(connection, { schema });
        this.answeredNotices = new AgentChatAnsweredNoticesModel(this.database);
        this.processGroups = new AgentChatProcessGroupsModel(this.database);
        this.subagents = new AgentChatSubagentsModel(this.database);
        this.versions = new AgentChatVersionsModel(this.database);
    }

    /**
     * Where a rewound Claude Code Chat resumes its transcript (a record uuid), written by "Edit from here" and cleared
     * when the first new turn writes past it or the Agent Session is replaced. Claude's transcript only grows, so
     * without it a Server Core restart between the rewind and the next turn would resume at the newest record and bring
     * the rewound turns back. `undefined` for every other provider and for a Chat that was not rewound. It does not
     * touch `updatedAt`: the resume point is private bookkeeping, not a change Clients refresh for.
     */
    resumeAt(terminalId: string): string | undefined {
        return (
            this.database
                .select({ resumeAt: terminals.chatResumeRecordId })
                .from(terminals)
                .where(eq(terminals.id, terminalId))
                .get()?.resumeAt ?? undefined
        );
    }

    setResumeAt(terminalId: string, resumeAt: string | undefined): void {
        this.database
            .update(terminals)
            .set({ chatResumeRecordId: resumeAt ?? null })
            .where(eq(terminals.id, terminalId))
            .run();
    }
}

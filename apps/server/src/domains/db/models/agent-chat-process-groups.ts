import { and, eq } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { agentChatProcessGroups } from '../schema';

/**
 * A provider process group Server Core spawned and has not reaped.
 */
export interface StoredProviderGroup {
    pgid: number;
    terminalId: string;
    leaderStartToken: string;
    recordedAt: number;
}

/**
 * Pure CRUD for the provider process groups of the running Server Core lifetime. A group is recorded at spawn and
 * forgotten once reaped, so what remains at the next start is exactly what a killed Server Core left behind.
 */
export class AgentChatProcessGroupsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    record(group: Omit<StoredProviderGroup, 'recordedAt'>, now = Date.now()): void {
        this.database
            .insert(agentChatProcessGroups)
            .values({ ...group, recordedAt: now })
            .onConflictDoUpdate({
                target: agentChatProcessGroups.pgid,
                set: {
                    terminalId: group.terminalId,
                    leaderStartToken: group.leaderStartToken,
                    recordedAt: now,
                },
            })
            .run();
    }

    forget(pgid: number, leaderStartToken?: string): void {
        this.database
            .delete(agentChatProcessGroups)
            .where(
                and(
                    eq(agentChatProcessGroups.pgid, pgid),
                    leaderStartToken === undefined
                        ? undefined
                        : eq(agentChatProcessGroups.leaderStartToken, leaderStartToken),
                ),
            )
            .run();
    }

    list(): StoredProviderGroup[] {
        return this.database.select().from(agentChatProcessGroups).all();
    }
}

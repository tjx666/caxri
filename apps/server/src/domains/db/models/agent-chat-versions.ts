import type {
    AgentChatItem,
    AgentChatTurn,
    AgentChatVersionContent,
    AgentChatVersionSummary,
} from '@caxri/protocol';
import {
    agentChatVersionContentSchema,
    MAX_AGENT_CHAT_VERSION_BYTES,
    MAX_AGENT_CHAT_VERSIONS,
} from '@caxri/protocol';
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { agentChatVersions } from '../schema';

export interface AgentChatVersionInput {
    terminalId: string;
    id: string;
    agentSessionId: string | null;
    anchorTurnId: string | null;
    items: readonly AgentChatItem[];
    turns: readonly AgentChatTurn[];
}

const MAX_PRUNE_PASSES = 32;

function sameSession(agentSessionId: string | null) {
    return agentSessionId === null
        ? isNull(agentChatVersions.agentSessionId)
        : eq(agentChatVersions.agentSessionId, agentSessionId);
}

/**
 * Pure CRUD for `agent_chat_versions`: the turns "Edit from here" replaced, which the provider no longer holds. The
 * rewind decides when a version is saved, re-anchored, or dropped.
 */
export class AgentChatVersionsModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Saves one version of the conversation that continues, and moves that conversation's versions anchored on one of
     * the replaced turns under it, since their anchor now lives only in its content. Then trims the Chat to
     * `MAX_AGENT_CHAT_VERSIONS` and `MAX_AGENT_CHAT_VERSION_BYTES`, oldest first, with the versions nested under a
     * dropped one; the version just saved always stays. The Terminal may be gone by the time a late rewind lands; its
     * foreign key then rejects the insert, which is ignored because there is no Chat left to show it in.
     */
    save(version: AgentChatVersionInput, now = Date.now()): void {
        const { terminalId } = version;
        const replacedTurnIds = version.turns.map((turn) => turn.id);
        try {
            this.database.transaction((transaction) => {
                if (replacedTurnIds.length > 0)
                    transaction
                        .update(agentChatVersions)
                        .set({ parentVersionId: version.id })
                        .where(
                            and(
                                eq(agentChatVersions.terminalId, terminalId),
                                sameSession(version.agentSessionId),
                                isNull(agentChatVersions.parentVersionId),
                                inArray(agentChatVersions.anchorTurnId, replacedTurnIds),
                            ),
                        )
                        .run();
                transaction
                    .insert(agentChatVersions)
                    .values({
                        terminalId,
                        id: version.id,
                        agentSessionId: version.agentSessionId,
                        parentVersionId: null,
                        anchorTurnId: version.anchorTurnId,
                        itemsJson: JSON.stringify(version.items),
                        turnsJson: JSON.stringify(version.turns),
                        createdAt: now,
                    })
                    .run();
                const rows = transaction
                    .select({
                        id: agentChatVersions.id,
                        bytes: sql<number>`length(${agentChatVersions.itemsJson}) + length(${agentChatVersions.turnsJson})`,
                    })
                    .from(agentChatVersions)
                    .where(eq(agentChatVersions.terminalId, terminalId))
                    .orderBy(desc(agentChatVersions.createdAt), desc(agentChatVersions.id))
                    .all();
                let bytes = 0;
                for (const [index, row] of rows.entries()) {
                    bytes += row.bytes;
                    if (
                        row.id === version.id ||
                        (index < MAX_AGENT_CHAT_VERSIONS && bytes <= MAX_AGENT_CHAT_VERSION_BYTES)
                    )
                        continue;
                    transaction
                        .delete(agentChatVersions)
                        .where(
                            and(
                                eq(agentChatVersions.terminalId, terminalId),
                                eq(agentChatVersions.id, row.id),
                            ),
                        )
                        .run();
                }
                // A version nested under a dropped one can no longer be reached; drop it too, level by level.
                for (let pass = 0; pass < MAX_PRUNE_PASSES; pass += 1) {
                    const kept = transaction
                        .select({ id: agentChatVersions.id })
                        .from(agentChatVersions)
                        .where(eq(agentChatVersions.terminalId, terminalId))
                        .all()
                        .map((row) => row.id);
                    const orphans = transaction
                        .delete(agentChatVersions)
                        .where(
                            and(
                                eq(agentChatVersions.terminalId, terminalId),
                                sql`${agentChatVersions.parentVersionId} IS NOT NULL`,
                                notInArray(agentChatVersions.parentVersionId, kept),
                            ),
                        )
                        .run();
                    if (orphans.changes === 0) break;
                }
            });
        } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('FOREIGN KEY')) throw error;
        }
    }

    setAnchor(terminalId: string, id: string, anchorTurnId: string | null): void {
        this.database
            .update(agentChatVersions)
            .set({ anchorTurnId })
            .where(and(eq(agentChatVersions.terminalId, terminalId), eq(agentChatVersions.id, id)))
            .run();
    }

    /**
     * Moves a conversation's versions to the Agent Session that continues it, such as the new Claude Code session an
     * edit of the first message starts.
     */
    moveSession(terminalId: string, from: string | null, to: string | null): void {
        if (from === to) return;
        this.database
            .update(agentChatVersions)
            .set({ agentSessionId: to })
            .where(and(eq(agentChatVersions.terminalId, terminalId), sameSession(from)))
            .run();
    }

    remove(terminalId: string, id: string): void {
        this.database
            .delete(agentChatVersions)
            .where(and(eq(agentChatVersions.terminalId, terminalId), eq(agentChatVersions.id, id)))
            .run();
    }

    /**
     * The conversation's versions, oldest first, without their content.
     */
    list(terminalId: string, agentSessionId: string | null): AgentChatVersionSummary[] {
        return this.database
            .select({
                id: agentChatVersions.id,
                parentVersionId: agentChatVersions.parentVersionId,
                anchorTurnId: agentChatVersions.anchorTurnId,
                createdAt: agentChatVersions.createdAt,
            })
            .from(agentChatVersions)
            .where(and(eq(agentChatVersions.terminalId, terminalId), sameSession(agentSessionId)))
            .orderBy(asc(agentChatVersions.createdAt), asc(agentChatVersions.id))
            .all();
    }

    /**
     * One version's content, or `undefined` when the Chat does not keep it. A row that no longer parses (written by an
     * older build) reads as missing rather than failing the Chat.
     */
    read(terminalId: string, id: string): AgentChatVersionContent | undefined {
        const row = this.database
            .select({ items: agentChatVersions.itemsJson, turns: agentChatVersions.turnsJson })
            .from(agentChatVersions)
            .where(and(eq(agentChatVersions.terminalId, terminalId), eq(agentChatVersions.id, id)))
            .get();
        if (!row) return;
        try {
            const parsed = agentChatVersionContentSchema.safeParse({
                items: JSON.parse(row.items) as unknown,
                turns: JSON.parse(row.turns) as unknown,
            });
            return parsed.success ? parsed.data : undefined;
        } catch {
            return;
        }
    }
}

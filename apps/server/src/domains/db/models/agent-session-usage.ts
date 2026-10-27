import type { AgentProvider, UsagePullRequestState } from '@caxri/protocol';
import { and, eq, isNotNull, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import {
    agentSessionUsage,
    externalAgentUsage,
    pullRequestOutcomes,
    sessions,
    terminals,
} from '../schema';

export interface AgentSessionUsageRow {
    provider: AgentProvider;
    agentSessionId: string;
    sessionId: string;
    projectId: string;
    terminalId: string;
    cwd: string;
    boundAt: number;
    sourceFingerprint: string | null;
    scannedAt: number | null;
    usageJson: string | null;
}

export interface ExternalAgentUsageRow {
    provider: AgentProvider;
    transcriptId: string;
    agentSessionId: string;
    path: string;
    cwd: string | null;
    sourceFingerprint: string;
    scannedAt: number;
    usageJson: string;
}

export interface PullRequestOutcomeRow {
    url: string;
    state: UsagePullRequestState;
    title: string;
    createdAt: number | null;
    mergedAt: number | null;
    additions: number;
    deletions: number;
    checkedAt: number;
}

/**
 * Durable ledger of Agent Sessions hosted by Caxri, the scan cache of Agent transcripts found outside it, plus the
 * GitHub outcomes of the pull requests they created. See the table docs in `schema.ts` for why neither table references
 * Sessions or Terminals through a foreign key.
 */
export class AgentSessionUsageModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    /**
     * Copies the current Agent Session binding of one Terminal (or of every bound Terminal when `terminalId` is
     * omitted) into the ledger. Re-binding an already recorded Agent Session from the same Terminal refreshes its
     * provider state root so a Claude `EnterWorktree` relocation stays findable; a binding observed from another
     * Terminal (for example a resume in a different Session) keeps the original owner, which first paid for the
     * conversation.
     */
    recordBindings(terminalId?: string, now = Date.now()): void {
        const bound = and(
            isNotNull(terminals.provider),
            isNotNull(terminals.agentSessionId),
            terminalId === undefined ? undefined : eq(terminals.id, terminalId),
        );
        this.database
            .insert(agentSessionUsage)
            .select(
                this.database
                    .select({
                        provider: sql<string>`${terminals.provider}`.as('provider'),
                        agentSessionId: sql<string>`${terminals.agentSessionId}`.as(
                            'agent_session_id',
                        ),
                        sessionId: terminals.sessionId,
                        projectId: sessions.projectId,
                        terminalId: terminals.id,
                        cwd: sql<string>`COALESCE(${terminals.agentCwd}, ${terminals.cwd})`.as(
                            'cwd',
                        ),
                        boundAt: sql<number>`${now}`.as('bound_at'),
                        sourceFingerprint: sql<null>`NULL`.as('source_fingerprint'),
                        scannedAt: sql<null>`NULL`.as('scanned_at'),
                        usageJson: sql<null>`NULL`.as('usage_json'),
                    })
                    .from(terminals)
                    .innerJoin(sessions, eq(sessions.id, terminals.sessionId))
                    .where(bound),
            )
            .onConflictDoUpdate({
                target: [agentSessionUsage.provider, agentSessionUsage.agentSessionId],
                set: { cwd: sql`excluded.cwd` },
                setWhere: sql`${agentSessionUsage.terminalId} = excluded.terminal_id AND ${agentSessionUsage.cwd} != excluded.cwd`,
            })
            .run();
    }

    list(): AgentSessionUsageRow[] {
        return this.database.select().from(agentSessionUsage).all() as AgentSessionUsageRow[];
    }

    /**
     * Conversations first bound to one Session's Terminals, through the `session_id` index.
     */
    listForSession(sessionId: string): AgentSessionUsageRow[] {
        return this.database
            .select()
            .from(agentSessionUsage)
            .where(eq(agentSessionUsage.sessionId, sessionId))
            .all() as AgentSessionUsageRow[];
    }

    saveScan(
        provider: AgentProvider,
        agentSessionId: string,
        scan: { sourceFingerprint: string; scannedAt: number; usageJson: string },
    ): void {
        this.database
            .update(agentSessionUsage)
            .set(scan)
            .where(
                and(
                    eq(agentSessionUsage.provider, provider),
                    eq(agentSessionUsage.agentSessionId, agentSessionId),
                ),
            )
            .run();
    }

    /**
     * Forgets a row's fingerprint so the next sync rescans its transcript even though the files did not change.
     */
    invalidateScan(provider: AgentProvider, agentSessionId: string): void {
        this.database
            .update(agentSessionUsage)
            .set({ sourceFingerprint: null })
            .where(
                and(
                    eq(agentSessionUsage.provider, provider),
                    eq(agentSessionUsage.agentSessionId, agentSessionId),
                ),
            )
            .run();
    }

    listExternal(): ExternalAgentUsageRow[] {
        return this.database.select().from(externalAgentUsage).all() as ExternalAgentUsageRow[];
    }

    saveExternalScan(row: ExternalAgentUsageRow): void {
        this.database
            .insert(externalAgentUsage)
            .values(row)
            .onConflictDoUpdate({
                target: [externalAgentUsage.provider, externalAgentUsage.transcriptId],
                set: row,
            })
            .run();
    }

    /**
     * The outside-Caxri counterpart of {@link invalidateScan}. The column is required, so an empty fingerprint, which no
     * scan produces, marks the row stale.
     */
    invalidateExternalScan(provider: AgentProvider, transcriptId: string): void {
        this.database
            .update(externalAgentUsage)
            .set({ sourceFingerprint: '' })
            .where(
                and(
                    eq(externalAgentUsage.provider, provider),
                    eq(externalAgentUsage.transcriptId, transcriptId),
                ),
            )
            .run();
    }

    listPullRequestOutcomes(): PullRequestOutcomeRow[] {
        return this.database.select().from(pullRequestOutcomes).all() as PullRequestOutcomeRow[];
    }

    savePullRequestOutcome(row: PullRequestOutcomeRow): void {
        this.database
            .insert(pullRequestOutcomes)
            .values(row)
            .onConflictDoUpdate({ target: pullRequestOutcomes.url, set: row })
            .run();
    }
}

import type { ClaudeWindowOutcome } from '@caxri/protocol';
import { claudeWindowOutcomes } from '@caxri/protocol';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { CaxriDrizzleDatabase } from '../connection';
import * as schema from '../full-schema';
import { claudeWindowSchedules } from '../schema-claude-windows';

export interface ClaudeWindowSchedule {
    accountHash: string;
    planType?: string;
    /**
     * Undefined while the plan default applies.
     */
    keepRolling?: boolean;
    firstWorkdayResetMinutes?: number;
    processedThrough?: number;
    observedResetAt?: number;
    triggeredResetAt?: number;
    lastOutcome?: { outcome: ClaudeWindowOutcome; at: number; missedPlannedAt?: number };
}

const outcomes: ReadonlySet<string> = new Set(claudeWindowOutcomes);

/**
 * Pure persistence for the Claude 5-hour window keeper, one row per account identity hash. The keeper's decisions live
 * in the `claude-windows` domain.
 */
export class ClaudeWindowSchedulesModel {
    private readonly database: CaxriDrizzleDatabase;

    /**
     * Takes the Server's open SQLite handle; the migration runner has already created the table on it.
     */
    constructor(connection: Database.Database) {
        this.database = drizzle(connection, { schema });
    }

    get(accountHash: string): ClaudeWindowSchedule | undefined {
        const row = this.database
            .select()
            .from(claudeWindowSchedules)
            .where(eq(claudeWindowSchedules.accountHash, accountHash))
            .get();
        if (!row) return undefined;
        const lastOutcome =
            row.lastOutcome !== null && outcomes.has(row.lastOutcome) && row.lastOutcomeAt !== null
                ? {
                      outcome: row.lastOutcome as ClaudeWindowOutcome,
                      at: row.lastOutcomeAt,
                      ...(row.missedPlannedAt !== null && {
                          missedPlannedAt: row.missedPlannedAt,
                      }),
                  }
                : undefined;
        return {
            accountHash: row.accountHash,
            ...(row.planType !== null && { planType: row.planType }),
            ...(row.keepRolling !== null && { keepRolling: row.keepRolling }),
            ...(row.firstWorkdayResetMinutes !== null && {
                firstWorkdayResetMinutes: row.firstWorkdayResetMinutes,
            }),
            ...(row.processedThrough !== null && { processedThrough: row.processedThrough }),
            ...(row.observedResetAt !== null && { observedResetAt: row.observedResetAt }),
            ...(row.triggeredResetAt !== null && { triggeredResetAt: row.triggeredResetAt }),
            ...(lastOutcome && { lastOutcome }),
        };
    }

    save(schedule: ClaudeWindowSchedule): void {
        const values = {
            planType: schedule.planType ?? null,
            keepRolling: schedule.keepRolling ?? null,
            firstWorkdayResetMinutes: schedule.firstWorkdayResetMinutes ?? null,
            processedThrough: schedule.processedThrough ?? null,
            observedResetAt: schedule.observedResetAt ?? null,
            triggeredResetAt: schedule.triggeredResetAt ?? null,
            lastOutcome: schedule.lastOutcome?.outcome ?? null,
            lastOutcomeAt: schedule.lastOutcome?.at ?? null,
            missedPlannedAt: schedule.lastOutcome?.missedPlannedAt ?? null,
            updatedAt: Date.now(),
        };
        this.database
            .insert(claudeWindowSchedules)
            .values({ accountHash: schedule.accountHash, ...values })
            .onConflictDoUpdate({ target: claudeWindowSchedules.accountHash, set: values })
            .run();
    }
}

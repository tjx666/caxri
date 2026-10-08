import type { AgentCommanderDiagnostics } from '@caxri/protocol';
import { logEventCatalog, MAX_DIAGNOSTIC_COMMANDER_DELEGATIONS } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import { commanderRunState } from './service';

type CompletionNoticeSummary = AgentCommanderDiagnostics['completionNotices'];

function finiteNonNegative(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface CompletionNoticeTally {
    deliveredBatches: number;
    deliveredNotices: number;
    deliveryFailures: { rejected: number; unconfirmed: number };
    maximumWaitMs: number | undefined;
    totalWaitMs: number;
}

function tallyCompletionNoticeLine(line: string, tally: CompletionNoticeTally): void {
    if (!line.includes('agent_commander.completion_notice_')) return;
    try {
        const record = JSON.parse(line) as { event?: unknown; fields?: unknown };
        const fields = (
            typeof record.fields === 'object' && record.fields !== null ? record.fields : {}
        ) as Record<string, unknown>;
        if (record.event === logEventCatalog.agentCommander.completionNoticeDelivered) {
            tally.deliveredBatches += 1;
            tally.deliveredNotices += finiteNonNegative(fields.count) ?? 0;
            const waitMs = finiteNonNegative(fields.waitMs);
            if (waitMs !== undefined) {
                tally.totalWaitMs += waitMs;
                tally.maximumWaitMs = Math.max(tally.maximumWaitMs ?? 0, waitMs);
            }
        } else if (
            record.event === logEventCatalog.agentCommander.completionNoticeDeliveryFailed &&
            (fields.reason === 'rejected' || fields.reason === 'unconfirmed')
        ) {
            tally.deliveryFailures[fields.reason] += 1;
        }
    } catch {
        // Ignore truncated lines left by an interrupted log write.
    }
}

/**
 * Aggregates the completion notice delivery log lines. Reads only the event name and the numeric or closed-enum fields
 * the notifier writes (`count`, `waitMs`, `reason`); the notice text itself is never logged.
 */
function summarizeCommanderCompletionNotices(logs: readonly string[]): CompletionNoticeSummary {
    const tally: CompletionNoticeTally = {
        deliveredBatches: 0,
        deliveredNotices: 0,
        deliveryFailures: { rejected: 0, unconfirmed: 0 },
        maximumWaitMs: undefined,
        totalWaitMs: 0,
    };
    /**
     * Dedupe exact lines: `flushSync` can append a batch whose async append is still in flight, so a record may appear
     * twice in the raw file. Every record carries its own timestamp, so identical lines are the same record.
     */
    const lines = new Set(logs.flatMap((log) => log.split('\n')));
    for (const line of lines) tallyCompletionNoticeLine(line, tally);
    return {
        deliveredBatches: tally.deliveredBatches,
        deliveredNotices: tally.deliveredNotices,
        ...(tally.deliveredBatches > 0 && {
            averageWaitMs: Math.round((tally.totalWaitMs / tally.deliveredBatches) * 100) / 100,
        }),
        ...(tally.maximumWaitMs !== undefined && { maximumWaitMs: tally.maximumWaitMs }),
        deliveryFailures: tally.deliveryFailures,
    };
}

/**
 * Builds the Commander section of `diagnostics.snapshot` from durable rows and retained logs. Receipts are projected
 * field by field, so a receipt field added later cannot widen the snapshot's content boundary by accident.
 */
export function commanderDiagnostics(
    database: CaxriDatabase,
    logs: readonly string[],
): AgentCommanderDiagnostics {
    const rows = database.agentCommanderRows();
    const terminal = rows?.terminalId ? database.getTerminal(rows.terminalId) : undefined;
    const recentDelegations = database.agentDelegations
        .receiptsForSessions(rows?.sessionIds ?? [])
        .toSorted((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_DIAGNOSTIC_COMMANDER_DELEGATIONS)
        .map((receipt) => ({
            delegationId: receipt.delegationId,
            sessionId: receipt.sessionId,
            provider: receipt.provider,
            status: receipt.status,
            ...(receipt.failure && { failure: receipt.failure }),
            ...(receipt.correlationFailure && { correlationFailure: receipt.correlationFailure }),
            isCommanderCaller: terminal !== undefined && receipt.callerTerminalId === terminal.id,
            createdAt: receipt.createdAt,
            updatedAt: receipt.updatedAt,
            durationMs: Math.max(0, receipt.updatedAt - receipt.createdAt),
        }));
    return {
        state: commanderRunState(database),
        ...(terminal && {
            terminalId: terminal.id,
            terminalProcessState: terminal.lastProcessState,
            ...(terminal.lastAgentProcessState && {
                agentProcessState: terminal.lastAgentProcessState,
            }),
        }),
        sessionCount: rows?.sessionIds.length ?? 0,
        recentDelegations,
        completionNotices: summarizeCommanderCompletionNotices(logs),
    };
}

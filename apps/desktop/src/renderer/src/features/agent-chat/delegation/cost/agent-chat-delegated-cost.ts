import type { AgentDelegationSession, DelegationCostSummary } from '@caxri/protocol';
import { formatUsd } from '@caxri/protocol';

import type { Translate } from '../../../../i18n';

/**
 * What one strip row (or the strip header) states about spend: an estimated list price, never a charge.
 */
export interface DelegatedCostFigure {
    costUsd: number;
    /**
     * True when a model had no list price, so the figure is a floor (`$1.20+`).
     */
    isPartial: boolean;
    /**
     * True while a task below the row still runs, so the figure may grow (`~$1.20`).
     */
    isActive: boolean;
}

/**
 * The visible text and the sentence that explains it. `text` carries the marker: `~` while running, `+` as a floor.
 */
export interface DelegatedCostLabel {
    /**
     * The accessible sentence: the amount, and why it is a `~` or `+` figure.
     */
    description: string;
    text: string;
}

/**
 * An amount as the strip writes it: `$1.20`, or `$1.20+` for a floor. `undefined` for a floor of nothing (`$0+` says
 * nothing), so no caller turns an unknown reading into `$0`. Shared by the row label and the tooltip.
 */
export function formatCostAmount(costUsd: number, isPartial: boolean): string | undefined {
    if (isPartial && costUsd === 0) return undefined;
    return `${formatUsd(costUsd)}${isPartial ? '+' : ''}`;
}

/**
 * The label for a figure, or `undefined` when there is nothing honest to show: no usage yet, or a floor of nothing but
 * unpriced models (`$0+` says nothing). A figure is never `$0` for an unknown reading.
 */
export function delegatedCostLabel(
    figure: DelegatedCostFigure | undefined,
    t: Translate,
): DelegatedCostLabel | undefined {
    if (figure === undefined) return undefined;
    const amount = formatCostAmount(figure.costUsd, figure.isPartial);
    if (amount === undefined) return undefined;
    const text = `${figure.isActive ? '~' : ''}${amount}`;
    const description = [
        t('delegation.strip.cost.rowLabel', { amount }),
        figure.isActive && t('delegation.strip.cost.running'),
        figure.isPartial && t('delegation.strip.cost.partial'),
    ]
        .filter(Boolean)
        .join(' ');
    return { description, text };
}

type CostChild = DelegationCostSummary['children'][number];

/**
 * The Sessions of every attempt in the retry chain a shown row stands for. The feed keeps one entry per Session and
 * hides a superseded failed attempt behind its successor (`collapseRetryChains`), but the spend of that attempt is
 * still the row's: a retry that ran in another Session cost real money too. Walks `retriedAs` back from the shown task
 * and its `retryOf`, so a chain of any length sums each distinct Session once.
 */
export function retryChainSessionIds(
    shown: Pick<AgentDelegationSession, 'delegationId' | 'retryOf' | 'sessionId'>,
    all: ReadonlyArray<
        Pick<AgentDelegationSession, 'delegationId' | 'retriedAs' | 'retryOf' | 'sessionId'>
    >,
): string[] {
    const sessionIds = new Set([shown.sessionId]);
    const taskIds = new Set<string>();
    if (shown.delegationId !== undefined) taskIds.add(shown.delegationId);
    if (shown.retryOf !== undefined) taskIds.add(shown.retryOf);
    let isChanged = true;
    while (isChanged) {
        const sizeBefore = taskIds.size;
        const linked = all.filter(
            (entry) => entry.retriedAs !== undefined && taskIds.has(entry.retriedAs),
        );
        for (const entry of linked) {
            sessionIds.add(entry.sessionId);
            if (entry.delegationId !== undefined) taskIds.add(entry.delegationId);
            if (entry.retryOf !== undefined) taskIds.add(entry.retryOf);
        }
        isChanged = taskIds.size > sizeBefore;
    }
    return [...sessionIds];
}

/**
 * One figure for several direct children: the sum, a floor if any is a floor, running if any runs. A child that only
 * has a running task (no usage yet, `sessionCount` 0) still makes the figure running, so a fresh retry keeps the `~`
 * its earlier attempt's spend needs. `undefined` when none of the Sessions has usage yet.
 */
export function sumDelegatedCost(
    sessionIds: readonly string[],
    children: readonly CostChild[],
): DelegatedCostFigure | undefined {
    const byId = new Map(children.map((child) => [child.sessionId, child]));
    let figure: DelegatedCostFigure | undefined;
    let isAnyActive = false;
    let sessionCount = 0;
    const distinctIds = new Set(sessionIds);
    for (const sessionId of distinctIds) {
        const child = byId.get(sessionId);
        if (child === undefined) continue;
        sessionCount += child.sessionCount;
        isAnyActive ||= child.isActive;
        figure = {
            costUsd: (figure?.costUsd ?? 0) + child.costUsd,
            isPartial: (figure?.isPartial ?? false) || child.isPartial,
            isActive: (figure?.isActive ?? false) || child.isActive,
        };
    }
    return figure && sessionCount > 0 ? { ...figure, isActive: isAnyActive } : undefined;
}

/**
 * The header's figure: everything below the Chat, from the summary. Hidden with no delegated Session that has usage.
 */
export function delegatedHeaderFigure(
    summary: DelegationCostSummary | undefined,
): DelegatedCostFigure | undefined {
    if (summary === undefined || summary.delegatedSessions === 0) return undefined;
    return {
        costUsd: summary.delegatedCostUsd,
        isPartial: summary.isPartial,
        isActive: summary.isActive,
    };
}

/**
 * How many completed reads the summary gets while the usage ledger is still scanning, and how long between them. A scan
 * that outlives them leaves the last answer in place (the next feed change or reopen reads again), so a stuck scan
 * never becomes a hot loop.
 */
export const COST_SCAN_POLL_MS = 3_000;
export const COST_SCAN_POLL_LIMIT = 20;

/**
 * The next `refetchInterval` for the summary. Pure: TanStack evaluates it on every configuration and state change, so
 * it must not count its own calls. The budget is the reads that completed since the scan became pending
 * (`fetchesSincePending`, counted by the caller), and `false` stops polling.
 */
export function costRefetchInterval(
    summary: Pick<DelegationCostSummary, 'isScanPending'> | undefined,
    fetchesSincePending: number,
): number | false {
    if (!summary?.isScanPending) return false;
    return fetchesSincePending < COST_SCAN_POLL_LIMIT ? COST_SCAN_POLL_MS : false;
}

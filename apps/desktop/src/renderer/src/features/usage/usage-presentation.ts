import type { UsageReport, UsageSessionRow } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { sessionTitleForDisplay } from '../session/session-title';

/**
 * Presentation rules shared by the Usage page's cards: bar tones and bases, tile detail facts, and the text twins of
 * muted rows. Kept apart from `usage-metrics.ts`, which owns the report's derived figures and wording.
 */
/**
 * A plan-limit window at or above this share of its allowance is drawn in `--warning`: close enough to the cap that the
 * next long turn may hit it.
 */
export const LIMIT_WARNING_PERCENT = 90;

/**
 * The fill role of a plan-limit bar. A limit bar is a quantity (`--chart`), not the screen's focus (`--accent`), and it
 * turns `--warning` once the window is nearly spent.
 */
export function limitBarTone(usedPercent: number): 'chart' | 'warning' {
    return usedPercent >= LIMIT_WARNING_PERCENT ? 'warning' : 'chart';
}

/**
 * What the Agents and Projects share bars are drawn from. Cost is the page's headline figure, so it wins whenever every
 * model in the range has a price; with any unpriced usage a cost share would draw an unpriced row as a zero-width bar
 * beside real tokens, so the bars fall back to tokens, which every row has.
 */
export type UsageShareBasis = 'cost' | 'tokens';

export function usageShareBasis(
    report: Pick<UsageReport, 'coverage'> & { totals: Pick<UsageReport['totals'], 'costUsd'> },
): UsageShareBasis {
    return report.totals.costUsd > 0 && report.coverage.unpricedModels.length === 0
        ? 'cost'
        : 'tokens';
}

/**
 * One row's share of the card total on the chosen basis, 0 when the total is empty.
 */
export function usageShare(
    row: { costUsd: number; tokens: number },
    total: { costUsd: number; tokens: number },
    basis: UsageShareBasis,
): number {
    const part = basis === 'cost' ? row.costUsd : row.tokens;
    const whole = basis === 'cost' ? total.costUsd : total.tokens;
    return whole > 0 ? part / whole : 0;
}

/**
 * The Pull requests tile's detail facts, each kept whole on one line by the caller. The line count is left out while no
 * merged pull request changed a line, since `+0 -0 lines` says nothing and wrapped awkwardly beside the opened count.
 */
export function pullRequestTileDetail(
    t: Translate,
    totals: Pick<UsageReport['totals'], 'linesAdded' | 'linesDeleted' | 'pullRequestsCreated'>,
    formatLines: (count: number) => string,
): string[] {
    const opened = t('usage.pullRequests.opened', {
        count: totals.pullRequestsCreated.toLocaleString('en-US'),
    });
    if (totals.linesAdded === 0 && totals.linesDeleted === 0) return [opened];
    return [
        t('usage.pullRequests.lines', {
            added: formatLines(totals.linesAdded),
            deleted: formatLines(totals.linesDeleted),
        }),
        opened,
    ];
}

/**
 * The text twin of a row's muted color: a removed Project, a deleted Session, or a Session run outside Caxri (titled by
 * its folder, so its title alone does not say so). Undefined for an ordinary row and for the `Outside Caxri` Project
 * row, whose title already names the state.
 */
export function usageRowStatusLabel(
    t: Translate,
    row: {
        isDeleted?: boolean;
        isOutsideCaxri: boolean;
        isRemoved?: boolean;
        kind: 'project' | 'session';
    },
): string | undefined {
    if (row.isRemoved) return t('usage.rowStatus.removed');
    if (row.isDeleted) return t('usage.rowStatus.deleted');
    if (row.isOutsideCaxri && row.kind === 'session') return t('usage.rowStatus.outsideCaxri');
    return undefined;
}

/**
 * The title a Most expensive Sessions row shows. The Server fills a deleted Session's title with an English constant
 * and an unnamed Session's with the stored `Untitled` placeholder; both are translated here, as the PrimarySidebar
 * does. A Session run outside Caxri is titled by its folder, which is the user's own text even when it reads
 * `Untitled`.
 */
export function usageSessionTitle(
    t: Translate,
    row: Pick<UsageSessionRow, 'isDeleted' | 'isOutsideCaxri' | 'title'>,
): string {
    if (row.isOutsideCaxri) return row.title;
    if (row.isDeleted) return t('usage.sessions.deletedTitle');
    return sessionTitleForDisplay(row.title, t);
}

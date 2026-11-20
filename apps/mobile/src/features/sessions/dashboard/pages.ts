import type { MobileDashboardParameters, MobileDashboardResult } from '@caxri/protocol';
import { MOBILE_DASHBOARD_GROUP_PAGE_SIZE } from '@caxri/protocol';

import type { SessionListGroupStates } from '../session-list-groups';
import type { MobileSessionListGroup } from '../session-model';
import { MOBILE_SESSION_LIST_GROUPS, mobileSessionListGroup } from '../session-model';

/**
 * How many rows of each group the list wants loaded, read from how far the reader revealed it. A group left out wants
 * only the first page every read answers.
 */
export type DashboardWants = Partial<Record<MobileSessionListGroup, number>>;

export interface DashboardScope {
    /**
     * The Project filter the Server applies; absent for All.
     */
    projectId?: string;
    wants: DashboardWants;
}

/**
 * The rows each group wants beyond the first page, so a reveal that stays inside rows already held changes nothing and
 * starts no read.
 */
export const dashboardWants = (states: SessionListGroupStates): DashboardWants => {
    const wants: DashboardWants = {};
    for (const group of MOBILE_SESSION_LIST_GROUPS) {
        const revealed = states[group]?.revealedCount ?? 0;
        if (revealed > MOBILE_DASHBOARD_GROUP_PAGE_SIZE) wants[group] = revealed;
    }
    return wants;
};

/**
 * A stable query key part for a scope, so polling and pushes reuse one query until the filter or a want changes.
 */
export const dashboardScopeKey = (scope: DashboardScope): string =>
    [
        scope.projectId ?? '*',
        ...MOBILE_SESSION_LIST_GROUPS.map((group) => scope.wants[group] ?? 0),
    ].join('|');

/**
 * A read can never need more `page` requests than this: the Server counts at most 4,096 rows and a page answers at
 * least one row or ends the loop.
 */
const MAXIMUM_PAGE_READS = 128;

/**
 * Reads the Session home for a scope: the first read, then for each group that wants more rows than it answered, `page`
 * reads from the end of what is held until the group holds what it wants or the Server has no more. Every read of a
 * poll repeats the same pages, so background refreshes keep the rows a reader revealed.
 *
 * `first` is the first read alone, the copy the phone saves; `merged` adds every page, without a Session twice when it
 * changed group between two reads.
 */
export const readDashboardPages = async (
    read: (parameters: MobileDashboardParameters) => Promise<MobileDashboardResult>,
    scope: DashboardScope,
): Promise<{ first: MobileDashboardResult; merged: MobileDashboardResult }> => {
    const filter = scope.projectId === undefined ? {} : { projectId: scope.projectId };
    const first = await read(filter);
    const held = new Map<MobileSessionListGroup, number>();
    for (const session of first.sessions) {
        const group = mobileSessionListGroup(session);
        held.set(group, (held.get(group) ?? 0) + 1);
    }
    const sessions = [...first.sessions];
    const seen = new Set(sessions.map(({ id }) => id));
    const keep = (rows: MobileDashboardResult['sessions']): void => {
        for (const session of rows)
            if (!seen.has(session.id)) {
                seen.add(session.id);
                sessions.push(session);
            }
    };
    let reads = 0;
    const readGroup = async (group: MobileSessionListGroup): Promise<void> => {
        const wanted = Math.min(scope.wants[group] ?? 0, first.groupTotals[group]);
        let count = held.get(group) ?? 0;
        while (count < wanted && reads < MAXIMUM_PAGE_READS) {
            reads += 1;
            // eslint-disable-next-line no-await-in-loop -- each page starts where the previous one ended.
            const page = await read({ ...filter, page: { group, offset: count } });
            if (page.sessions.length === 0) return;
            count += page.sessions.length;
            keep(page.sessions);
        }
    };
    for (const group of MOBILE_SESSION_LIST_GROUPS)
        // eslint-disable-next-line no-await-in-loop -- groups page one after another so a read stays one frame at a time.
        await readGroup(group);
    return {
        first,
        merged: { ...first, sessions, truncated: sessions.length < first.total },
    };
};

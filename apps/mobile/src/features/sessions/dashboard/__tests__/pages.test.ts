import type { MobileDashboardParameters, MobileDashboardResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { dashboardScopeKey, dashboardWants, readDashboardPages } from '../pages';

type Row = MobileDashboardResult['sessions'][number];

const row = (id: string, status: 'needs-attention' | 'idle'): Row =>
    ({ hasPendingAttention: status === 'needs-attention', id }) as unknown as Row;

/**
 * A fake Server holding `attention` and `idle` rows that answers the first read with 15 per group and a `page` read
 * with up to 50 rows from the offset, as `buildMobileDashboard` does.
 */
const fakeServer = (counts: { attention: number; idle: number }) => {
    const groups = {
        attention: Array.from({ length: counts.attention }, (_, index) =>
            row(`attention-${index}`, 'needs-attention'),
        ),
        idle: Array.from({ length: counts.idle }, (_, index) => row(`idle-${index}`, 'idle')),
    };
    const reads: MobileDashboardParameters[] = [];
    const read = (parameters: MobileDashboardParameters): Promise<MobileDashboardResult> => {
        reads.push(parameters);
        const page = parameters?.page;
        const sessions = page
            ? (page.group === 'attention' || page.group === 'idle' ? groups[page.group] : []).slice(
                  page.offset,
                  page.offset + 50,
              )
            : [...groups.attention.slice(0, 15), ...groups.idle.slice(0, 15)];
        return Promise.resolve({
            deviceRole: 'full',
            groupTotals: { pinned: 0, attention: counts.attention, working: 0, idle: counts.idle },
            hostDisplayName: 'Host',
            projects: [],
            sessions,
            total: counts.attention + counts.idle,
            truncated: sessions.length < counts.attention + counts.idle,
        } as unknown as MobileDashboardResult);
    };
    return { read, reads };
};

describe('readDashboardPages', () => {
    it('answers the first read alone while no group wants more', async () => {
        const server = fakeServer({ attention: 70, idle: 1 });
        const { merged } = await readDashboardPages(server.read, { wants: {} });
        expect(server.reads).toEqual([{}]);
        expect(merged.sessions).toHaveLength(16);
        expect(merged.truncated).toBe(true);
        expect(merged.sessions.map(({ id }) => id)).toContain('idle-0');
    });

    it('pages a group from the rows it holds up to what it wants, capped by its total', async () => {
        const server = fakeServer({ attention: 70, idle: 3 });
        const { first, merged } = await readDashboardPages(server.read, {
            projectId: 'p',
            wants: { attention: 200, idle: 25 },
        });
        expect(server.reads).toEqual([
            { projectId: 'p' },
            { projectId: 'p', page: { group: 'attention', offset: 15 } },
            { projectId: 'p', page: { group: 'attention', offset: 65 } },
        ]);
        expect(merged.sessions).toHaveLength(73);
        expect(merged.truncated).toBe(false);
        expect(first.sessions).toHaveLength(18);
    });

    it('keeps one copy of a Session two reads both answered', async () => {
        const base = fakeServer({ attention: 20, idle: 0 });
        const read = async (parameters: MobileDashboardParameters) => {
            const result = await base.read(parameters);
            // The page repeats a row the first read held, as when a Session changed place between the two reads.
            return parameters?.page
                ? {
                      ...result,
                      sessions: [row('attention-0', 'needs-attention'), ...result.sessions],
                  }
                : result;
        };
        const { merged } = await readDashboardPages(read, { wants: { attention: 25 } });
        expect(
            merged.sessions.map(({ id }) => id).filter((id) => id === 'attention-0'),
        ).toHaveLength(1);
        expect(merged.sessions).toHaveLength(20);
    });

    it('stops at a page that answers nothing', async () => {
        const server = fakeServer({ attention: 15, idle: 0 });
        const read = async (parameters: MobileDashboardParameters) => {
            const result = await server.read(parameters);
            return parameters?.page
                ? result
                : { ...result, groupTotals: { ...result.groupTotals, attention: 40 } };
        };
        await readDashboardPages(read, { wants: { attention: 40 } });
        expect(server.reads).toHaveLength(2);
    });
});

describe('dashboardWants', () => {
    it('wants only groups revealed past the first page', () => {
        expect(
            dashboardWants({
                attention: { revealedCount: 25 },
                idle: { revealedCount: 15 },
                working: { isCollapsed: true },
            }),
        ).toEqual({ attention: 25 });
    });
});

describe('dashboardScopeKey', () => {
    it('changes with the filter or a want and nothing else', () => {
        expect(dashboardScopeKey({ wants: {} })).toBe('*|0|0|0|0');
        expect(dashboardScopeKey({ projectId: 'p', wants: { idle: 25 } })).toBe('p|0|0|0|25');
    });
});

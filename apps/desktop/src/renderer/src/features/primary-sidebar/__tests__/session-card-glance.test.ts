import { describe, expect, it } from 'vitest';

import { sessionCardMetrics } from '../session-card-glance';

const t = ((key: string, values?: { value?: string }) =>
    values?.value ? `${key}:${values.value}` : key) as never;

describe('sessionCardMetrics', () => {
    it('lists CPU, memory, and spend in that order', () => {
        expect(
            sessionCardMetrics(
                { cpuPercent: 12.4, memoryMb: 412, processCount: 3 },
                { costUsd: 3.214, isPartial: false },
                t,
            ),
        ).toEqual([
            {
                kind: 'cpu',
                name: 'primarySidebar.card.cpuName',
                value: '12%',
                label: 'primarySidebar.card.cpu:12%',
            },
            {
                kind: 'memory',
                name: 'primarySidebar.card.memoryName',
                value: '412.0 MB',
                label: 'primarySidebar.card.memory:412.0 MB',
            },
            { kind: 'cost', value: '$3.21', label: 'primarySidebar.card.cost:$3.21' },
        ]);
    });

    it('leaves out readings that are absent instead of showing zero', () => {
        expect(sessionCardMetrics(null, null, t)).toEqual([]);
        expect(
            sessionCardMetrics(undefined, { costUsd: 1, isPartial: false }, t).map(
                ({ kind }) => kind,
            ),
        ).toEqual(['cost']);
    });

    it('marks a spend with an unpriced model as a floor', () => {
        expect(sessionCardMetrics(null, { costUsd: 1.5, isPartial: true }, t)).toEqual([
            { kind: 'cost', value: '$1.50+', label: 'primarySidebar.card.costPartial:$1.50' },
        ]);
        expect(sessionCardMetrics(null, { costUsd: 0, isPartial: true }, t)).toEqual([]);
    });
});

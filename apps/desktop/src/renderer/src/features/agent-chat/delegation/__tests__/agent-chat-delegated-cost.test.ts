import { describe, expect, it } from 'vitest';

import type { Translate } from '../../../../i18n';
import {
    delegatedCostLabel,
    delegatedHeaderFigure,
    retryChainSessionIds,
    sumDelegatedCost,
} from '../cost/agent-chat-delegated-cost';

const t = ((key: string, values?: Record<string, unknown>) =>
    `${key}:${typeof values?.amount === 'string' ? values.amount : ''}`) as Translate;

const child = (sessionId: string, costUsd: number, flags = {}) => ({
    sessionId,
    costUsd,
    isPartial: false,
    isActive: false,
    sessionCount: 1,
    ...flags,
});

describe('delegatedCostLabel', () => {
    it('writes a plain estimate without a marker', () => {
        expect(delegatedCostLabel({ costUsd: 1.2, isPartial: false, isActive: false }, t)).toEqual({
            text: '$1.20',
            description: 'delegation.strip.cost.rowLabel:$1.20',
        });
    });

    it('marks a running figure with ~ and a floor with +', () => {
        expect(
            delegatedCostLabel({ costUsd: 1.2, isPartial: false, isActive: true }, t)?.text,
        ).toBe('~$1.20');
        expect(
            delegatedCostLabel({ costUsd: 1.2, isPartial: true, isActive: false }, t)?.text,
        ).toBe('$1.20+');
        expect(delegatedCostLabel({ costUsd: 1.2, isPartial: true, isActive: true }, t)).toEqual({
            text: '~$1.20+',
            description:
                'delegation.strip.cost.rowLabel:$1.20+ delegation.strip.cost.running: delegation.strip.cost.partial:',
        });
    });

    it('shows nothing for an unknown reading or a floor of nothing', () => {
        expect(delegatedCostLabel(undefined, t)).toBeUndefined();
        expect(
            delegatedCostLabel({ costUsd: 0, isPartial: true, isActive: false }, t),
        ).toBeUndefined();
        // A priced zero is a real, free reading.
        expect(delegatedCostLabel({ costUsd: 0, isPartial: false, isActive: false }, t)?.text).toBe(
            '$0',
        );
    });
});

describe('delegatedHeaderFigure', () => {
    it('is hidden until a delegated Session has usage', () => {
        const base = {
            delegatedCostUsd: 0,
            delegatedSessions: 0,
            isPartial: false,
            isActive: false,
            isScanPending: false,
            children: [],
        };

        expect(delegatedHeaderFigure(undefined)).toBeUndefined();
        expect(delegatedHeaderFigure(base)).toBeUndefined();
        expect(
            delegatedHeaderFigure({ ...base, delegatedSessions: 2, delegatedCostUsd: 3 }),
        ).toEqual({
            costUsd: 3,
            isPartial: false,
            isActive: false,
        });
    });
});

describe('sumDelegatedCost', () => {
    it('sums each distinct Session once and carries the floor and running flags', () => {
        const children = [
            child('a', 1),
            child('b', 2, { isPartial: true }),
            child('c', 4, { isActive: true }),
        ];

        expect(sumDelegatedCost(['a', 'b', 'a'], children)).toEqual({
            costUsd: 3,
            isPartial: true,
            isActive: false,
        });
        expect(sumDelegatedCost(['a', 'c'], children)?.isActive).toBe(true);
        expect(sumDelegatedCost(['missing'], children)).toBeUndefined();
    });
});

describe('retryChainSessionIds', () => {
    const entry = (
        sessionId: string,
        fields: { delegationId?: string; retriedAs?: string; retryOf?: string } = {},
    ) => ({ sessionId, ...fields });

    it('is just the row for a task nothing retried', () => {
        const shown = entry('s1', { delegationId: 't1' });

        expect(retryChainSessionIds(shown, [shown])).toEqual(['s1']);
    });

    it('adds the Sessions of every superseded attempt, however long the chain', () => {
        const first = entry('s1', { delegationId: 't1', retriedAs: 't2' });
        const second = entry('s2', { delegationId: 't2', retryOf: 't1', retriedAs: 't3' });
        const shown = entry('s3', { delegationId: 't3', retryOf: 't2' });
        const unrelated = entry('s9', { delegationId: 't9' });

        expect(
            retryChainSessionIds(shown, [first, second, shown, unrelated]).toSorted((a, b) =>
                a.localeCompare(b),
            ),
        ).toEqual(['s1', 's2', 's3']);
    });

    it('counts a resume retry that reuses the Session once', () => {
        const shown = entry('s1', { delegationId: 't2', retryOf: 't1' });

        expect(retryChainSessionIds(shown, [shown])).toEqual(['s1']);
    });
});

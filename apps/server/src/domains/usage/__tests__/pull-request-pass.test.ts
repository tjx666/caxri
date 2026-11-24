import { describe, expect, it, vi } from 'vitest';

import type { PullRequestOutcomeRow } from '../../db';
import type { ExternalStatusRunner } from '../../external-status';
import { FAILED_LOOKUP_BACKOFF_MS, PullRequestPass } from '../pull-request-pass/pull-request-pass';
import type { UsageLedgerEntry } from '../report';

const url = (n: number) => `https://github.com/acme/widgets/pull/${n}`;

describe('PullRequestPass', () => {
    it('resolves good pull requests behind permanent failures and backs the failures off', async () => {
        const stored = new Map<string, PullRequestOutcomeRow>();
        const asked: string[] = [];
        let clock = 1_000_000;
        const runner: ExternalStatusRunner = (_command, arguments_) => {
            const number = Number(arguments_[2]);
            asked.push(url(number));
            if (number > 45) {
                return Promise.resolve(JSON.stringify({ state: 'MERGED', title: `PR ${number}` }));
            }
            return Promise.reject(new Error('boom'));
        };
        const pass = new PullRequestPass({
            database: {
                agentSessionUsage: {
                    listPullRequestOutcomes: () => Array.from(stored.values()),
                    savePullRequestOutcome: (row: PullRequestOutcomeRow) => {
                        stored.set(row.url, row);
                    },
                },
            } as never,
            logger: { write: vi.fn() } as never,
            runner,
            now: () => clock,
        });
        const pullRequests = [
            'not-a-url',
            'https://github.com/acme/widgets/pull/1/files',
            ...Array.from({ length: 50 }, (_, index) => url(index + 1)),
        ];
        const entries = [{ record: { pullRequests } }] as unknown as UsageLedgerEntry[];
        const settle = () =>
            vi.waitFor(() =>
                expect((pass as unknown as { running?: unknown }).running).toBeUndefined(),
            );

        for (let round = 0; round < 3; round += 1) {
            pass.schedule(entries);
            // eslint-disable-next-line no-await-in-loop -- passes must run one at a time
            await settle();
        }
        const byText = (a: string, b: string) => a.localeCompare(b);
        expect(Array.from(stored.keys()).toSorted(byText)).toEqual(
            Array.from({ length: 5 }, (_, index) => url(index + 46)).toSorted(byText),
        );

        const askedBefore = asked.length;
        pass.schedule(entries);
        await settle();
        expect(asked.length).toBe(askedBefore);

        clock += FAILED_LOOKUP_BACKOFF_MS;
        pass.schedule(entries);
        await settle();
        expect(asked.length).toBeGreaterThan(askedBefore);
    });
});

import type { ProjectStatusRepository } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { refreshLogRecord, summarizeRefreshErrors } from '../refresh-log';

const repo = (
    errors: ProjectStatusRepository['errors'],
    publication?: ProjectStatusRepository['publication'],
) => ({ errors, publication }) as ProjectStatusRepository;

describe('summarizeRefreshErrors', () => {
    it('keeps a refresh with only missing prerequisites out of the failure bucket', () => {
        const summary = summarizeRefreshErrors([
            repo([{ source: 'vercel', kind: 'prerequisite', message: '', hint: '' }]),
        ]);
        expect(summary.result).toBe('prerequisite');
        expect(Object.fromEntries(summary.counts)).toEqual({ vercelPrerequisite: 1 });
    });

    it('counts failures by source and reason', () => {
        const summary = summarizeRefreshErrors([
            repo([
                {
                    source: 'github',
                    kind: 'failure',
                    reason: 'rate-limited',
                    message: '',
                    hint: '',
                },
                { source: 'linear', kind: 'failure', reason: 'tls', message: '', hint: '' },
                { source: 'acceptance', kind: 'failure', message: '', hint: '' },
            ]),
            repo([]),
        ]);
        expect(summary.result).toBe('failure');
        expect(Object.fromEntries(summary.counts)).toEqual({
            githubRateLimited: 1,
            linearTls: 1,
            acceptanceFailure: 1,
        });
    });
});

describe('refreshLogRecord', () => {
    it('writes a failure at warn with its cause counters and publication tallies', () => {
        const record = refreshLogRecord(
            [
                repo(
                    [
                        {
                            source: 'github',
                            kind: 'failure',
                            reason: 'network',
                            message: '',
                            hint: '',
                        },
                    ],
                    {
                        state: 'unpublished',
                    },
                ),
                repo([], { state: 'synced' }),
            ],
            300_000,
        );
        expect(record).toEqual({
            level: 'warn',
            fields: {
                repositories: 2,
                result: 'failure',
                ttlMs: 300_000,
                errorGithubNetwork: 1,
                publicationConfirmed: 1,
                publicationAbsent: 1,
                publicationUnknown: 0,
            },
        });
    });

    it('writes a prerequisite-only refresh at info', () => {
        const record = refreshLogRecord(
            [repo([{ source: 'vercel', kind: 'prerequisite', message: '', hint: '' }])],
            300_000,
        );
        expect(record.level).toBe('info');
        expect(record.fields).toMatchObject({ result: 'prerequisite', errorVercelPrerequisite: 1 });
    });
});

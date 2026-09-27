import { describe, expect, it } from 'vitest';

import {
    extractPullRequestNumbers,
    formatNightlyReport,
    summarizeFailures,
} from '../ci-nightly-report';

describe('nightly failure report', () => {
    it('keeps only failed jobs and their failed steps', () => {
        expect(
            summarizeFailures([
                { conclusion: 'success', name: 'retry-policy' },
                {
                    conclusion: 'failure',
                    html_url: 'https://example.com/job/1',
                    name: 'e2e',
                    steps: [
                        { conclusion: 'success', name: 'Build Electron bundles' },
                        { conclusion: 'failure', name: 'Run parallel-safe pool' },
                    ],
                },
            ]),
        ).toEqual([
            { job: 'e2e', steps: ['Run parallel-safe pool'], url: 'https://example.com/job/1' },
        ]);
    });

    it('extracts merged pull requests from squash subjects only', () => {
        expect(
            extractPullRequestNumbers([
                'feat(desktop): badge child repositories (#1301)\n\nBody mentions (#99)',
                'release: v0.0.74',
                'fix: another (#1303)',
                'fix: another (#1303)',
            ]),
        ).toEqual([1301, 1303]);
    });

    it('names the run, commit range, failures, and candidate pull requests', () => {
        const report = formatNightlyReport({
            commitCount: 2,
            failures: [{ job: 'e2e', steps: ['Run parallel-safe pool'] }],
            headSha: 'b'.repeat(40),
            previousGreenSha: 'a'.repeat(40),
            pullRequests: [1301],
            runUrl: 'https://example.com/run/1',
        });

        expect(report).toContain('https://example.com/run/1');
        expect(report).toContain('`aaaaaaaaa..bbbbbbbbb`，共 2 个提交');
        expect(report).toContain('- e2e：`Run parallel-safe pool`');
        expect(report).toContain('- #1301');
    });
});

import { describe, expect, it } from 'vitest';

import {
    COMMENT_MARKER,
    formatBytes,
    formatSizeChange,
    pickBaseline,
    renderComment,
    summarizeChatSwitch,
} from '../ci-size-comment';
import type { SizeReport } from '../ci-size-report';

const HEAD = '1'.repeat(40);
const BASE = '2'.repeat(40);
const MiB = 1_024 * 1_024;

const desktop = (sha: string, renderer: number): SizeReport => ({
    schema: 1,
    kind: 'desktop',
    sha,
    components: {
        'out/main': { bytes: 2 * MiB, sourceMapBytes: 4 * MiB },
        'out/renderer': { bytes: renderer, sourceMapBytes: 90 * MiB },
    },
});

describe('ci-size-comment', () => {
    it('formats byte counts and signed changes', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1_536)).toBe('1.5 KiB');
        expect(formatBytes(3 * MiB)).toBe('3.00 MiB');
        expect(formatSizeChange(110, 100)).toBe('+10 B (+10.0%)');
        expect(formatSizeChange(90 * 1_024, 100 * 1_024)).toBe('-10.0 KiB (-10.0%)');
        expect(formatSizeChange(100, 100)).toBe('0');
        expect(formatSizeChange(100, undefined)).toBe('new');
    });

    it('picks the baseline nearest the merge base', () => {
        const artifacts = [
            { runId: 3, sha: 'c' },
            { runId: 2, sha: 'b' },
        ];
        expect(pickBaseline(['a', 'b', 'c'], artifacts)).toEqual({ runId: 2, sha: 'b' });
        expect(pickBaseline(['c'], artifacts)).toEqual({ runId: 3, sha: 'c' });
        expect(pickBaseline(['x', 'y'], artifacts)).toBeUndefined();
    });

    it('renders deltas against the baseline and explains every missing section', () => {
        const body = renderComment({
            baselines: { desktop: desktop(BASE, 40 * MiB) },
            headSha: HEAD,
            reports: { desktop: desktop(HEAD, 41 * MiB) },
            runUrl: 'https://github.com/owner/project/actions/runs/1',
        });

        expect(body.startsWith(COMMENT_MARKER)).toBe(true);
        expect(body).toContain('**Desktop build** (compared with `main` at `2222222`)');
        expect(body).toContain('| out/renderer | 41.00 MiB | +1.00 MiB (+2.5%) | 46.00 MiB |');
        expect(body).toContain('| out/main | 2.00 MiB | 0 | 2.50 MiB |');
        expect(body).toContain('only full-scope CI runs package the app');
        expect(body).toContain('the mobile export did not upload a report');
        expect(body).toContain(
            '_Not measured: the Agent Chat Session switch benchmark uploaded no receipt',
        );
    });

    it('shows absolute sizes when no baseline exists', () => {
        const body = renderComment({
            baselines: {},
            headSha: HEAD,
            reports: { desktop: desktop(HEAD, 41 * MiB) },
            runUrl: 'https://github.com/owner/project/actions/runs/1',
        });
        expect(body).toContain('no `main` baseline within 30 commits, absolute sizes only');
        expect(body).toContain('| out/renderer | 41.00 MiB | — | 46.00 MiB |');
    });

    it('reads only finite p50 figures from a performance receipt', () => {
        const rows = summarizeChatSwitch(
            {
                scenarios: {
                    cached: {
                        readableMs: { p50: 71.25 },
                        interactiveMs: { p50: 80 },
                        react: { commitCount: { p50: 4 } },
                    },
                    cold: { readableMs: { p50: '<script>' } },
                },
            },
            { metrics: { 'scenarios.cached.readableMs.p50': { thresholdMs: 177.9 } } },
        );
        expect(rows.find(({ scenario }) => scenario === 'cached')).toEqual({
            scenario: 'cached',
            readableP50Ms: 71.25,
            interactiveP50Ms: 80,
            commitsP50: 4,
            readableThresholdMs: 177.9,
        });
        expect(rows.find(({ scenario }) => scenario === 'cold')?.readableP50Ms).toBeUndefined();

        const body = renderComment({
            baselines: {},
            headSha: HEAD,
            performance: {
                rows,
                runUrl: 'https://github.com/owner/project/actions/runs/2',
                source: 'hosted-full',
            },
            reports: { desktop: desktop(HEAD, MiB) },
            runUrl: 'https://github.com/owner/project/actions/runs/1',
        });
        expect(body).toContain(
            '[hosted-full run](https://github.com/owner/project/actions/runs/2)',
        );
        expect(body).toContain('| cached | 71.3 ms | 80.0 ms | 4 | 177.9 ms |');
        expect(body).toContain('| cold | — | — | — | — |');
        expect(body).not.toContain('<script>');
    });

    it('links the pull request CI run when that run measured the switch', () => {
        const body = renderComment({
            baselines: {},
            headSha: HEAD,
            performance: {
                rows: summarizeChatSwitch({}, {}),
                runUrl: 'https://github.com/owner/project/actions/runs/1',
                source: 'pull-request',
            },
            reports: { desktop: desktop(HEAD, MiB) },
            runUrl: 'https://github.com/owner/project/actions/runs/1',
        });
        expect(body).toContain(
            '**Performance** (Agent Chat Session switch, [CI run](https://github.com/owner/project/actions/runs/1);',
        );
        expect(body).not.toContain('hosted-full run');
    });
});

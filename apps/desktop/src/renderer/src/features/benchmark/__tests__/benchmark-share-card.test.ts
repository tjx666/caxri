import type { BenchmarkAttempt, BenchmarkEntry, BenchmarkRun } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildChart, configResults, qualitySource, rankResults } from '../benchmark-results';
import type { ShareCardPalette } from '../benchmark-share-card';
import {
    buildShareCard,
    renderShareCardSvg,
    SHARE_CARD_TOP_COUNT,
    SHARE_CARD_WIDTH,
    shareCardFileName,
    truncateForCard,
} from '../benchmark-share-card';

const PALETTE: ShareCardPalette = {
    background: '#101010',
    border: '#333333',
    fontFamily: 'sans-serif',
    foreground: '#ffffff',
    muted: '#999999',
    series: { claude: '#f00', codex: '#0f0', grok: '#00f', antigravity: '#ff0' },
};

function attempt(entryIndex: number, overrides: Partial<BenchmarkAttempt>): BenchmarkAttempt {
    return {
        id: `attempt-${entryIndex}`,
        entryIndex,
        repeat: 1,
        status: 'completed',
        steps: 3,
        durationMs: 12_000,
        ...overrides,
    };
}

function judgedRun(count: number, title = 'Fix the <flaky> test & more'): BenchmarkRun {
    const entries: BenchmarkEntry[] = Array.from({ length: count }, (_, index) => ({
        provider: 'codex',
        model: `model-${index}`,
        effort: 'high',
    }));
    return {
        id: 'run',
        title,
        prompt: title,
        entries,
        settings: {
            workspace: { kind: 'empty' },
            repeats: 1,
            concurrency: 3,
            timeoutMinutes: 20,
            judge: { provider: 'claude', model: 'opus' },
        },
        status: 'completed',
        createdAt: Date.UTC(2026, 9, 20, 8, 30),
        attempts: entries.map((_, index) =>
            attempt(index, {
                costUsd: 0.1 * (index + 1),
                judge: { score: 90 - index * 5, reason: '' },
            }),
        ),
    };
}

function card(run: BenchmarkRun, topCount?: number) {
    const results = configResults(run);
    const source = qualitySource(run, results);
    return buildShareCard({
        chart: buildChart(results, source, 'cost'),
        nameOf: (entry) => entry.model,
        ranked: rankResults(results, source),
        source,
        text: {
            cost: 'Cost',
            madeWith: 'Made with Caxri',
            mostEfficient: 'most efficient',
            quality: 'Judge score',
            subtitle: 'Oct 20, 2026 · Judged by Claude',
            time: 'Time',
            xTitle: 'Cost, less',
            yTitle: 'Judge score',
        },
        title: run.title,
        topCount,
    });
}

describe('buildShareCard', () => {
    it('keeps only the top rows, best first, with formatted figures', () => {
        const model = card(judgedRun(8));

        expect(model.rows).toHaveLength(SHARE_CARD_TOP_COUNT);
        expect(model.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5]);
        expect(model.rows[0]).toMatchObject({ name: 'model-0 high', quality: '90', cost: '$0.10' });
        expect(model.width).toBe(SHARE_CARD_WIDTH);
        expect(model.chart.layout.points).toHaveLength(8);
    });

    it('omits the quality column when the run has no quality signal', () => {
        const run = judgedRun(2);
        run.settings.judge = undefined;
        run.attempts = run.attempts.map((item) => ({ ...item, judge: undefined }));
        const model = card(run);

        expect(model.headers.quality).toBeUndefined();
        expect(model.rows.every((row) => row.quality === undefined)).toBe(true);
    });

    it('lists no unfinished Entry on the leaderboard', () => {
        const run = judgedRun(2);
        run.attempts[1] = { ...run.attempts[1], status: 'failed' };

        expect(card(run).rows.map((row) => row.name)).toEqual(['model-0 high']);
    });
});

describe('renderShareCardSvg', () => {
    it('draws the title, credit, and rows as standalone SVG with escaped text', () => {
        const svg = renderShareCardSvg(card(judgedRun(3)), PALETTE);

        expect(svg.startsWith('<svg xmlns=')).toBe(true);
        expect(svg).toContain('Fix the &lt;flaky&gt; test &amp; more');
        expect(svg).toContain('Made with Caxri');
        expect(svg).toContain('model-2 high');
        expect(svg).not.toContain('var(');
        expect(svg).not.toContain('<flaky>');
    });
});

describe('truncateForCard', () => {
    it('collapses whitespace and ends an over-long text in an ellipsis', () => {
        expect(truncateForCard('a  b\nc', 10)).toBe('a b c');
        expect(truncateForCard('abcdefghij', 5)).toBe('abcd…');
    });
});

describe('shareCardFileName', () => {
    it('slugs the title and appends the UTC date', () => {
        expect(
            shareCardFileName({
                title: 'Fix the flaky test!',
                createdAt: Date.UTC(2026, 9, 20, 23, 59),
            }),
        ).toBe('caxri-benchmark-fix-the-flaky-test-2026-10-20.png');
    });

    it('keeps non-Latin letters and survives an empty slug', () => {
        const createdAt = Date.UTC(2026, 0, 2);
        expect(shareCardFileName({ title: '修复 测试', createdAt })).toBe(
            'caxri-benchmark-修复-测试-2026-01-02.png',
        );
        expect(shareCardFileName({ title: '!!!', createdAt })).toBe(
            'caxri-benchmark-2026-01-02.png',
        );
    });
});

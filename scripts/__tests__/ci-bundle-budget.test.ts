import { describe, expect, it } from 'vitest';

import {
    buildSummaryMarkdown,
    findBudgetViolations,
    findModuleResolutionFailure,
    formatDeltaPercent,
    formatMeasurement,
    PACKAGED_SERVER_ENTRIES,
    REPORT_COMPONENTS,
    SIZE_BUDGETS,
    TIME_BUDGETS,
} from '../ci-bundle-budget';
import { isProtectedRetryPath } from '../ci-path-policy';

describe('ci-bundle-budget', () => {
    it('flags only measurements that exceed their budget', () => {
        const violations = findBudgetViolations([
            { label: 'out/main', actual: 100, budget: 200, unit: 'bytes' },
            { label: 'out/renderer', actual: 300, budget: 200, unit: 'bytes' },
            { label: 'build time', actual: 200, budget: 200, unit: 'seconds' },
        ]);
        expect(violations.map((violation) => violation.label)).toEqual(['out/renderer']);
    });

    it('formats byte measurements in MiB with budget status', () => {
        const line = formatMeasurement({
            label: 'out/renderer',
            actual: 35 * 1_024 * 1_024,
            budget: 34 * 1_024 * 1_024,
            unit: 'bytes',
        });
        expect(line).toBe('out/renderer: 35.00 MiB (budget 34.00 MiB) OVER BUDGET');
    });

    it('formats time measurements in seconds', () => {
        const line = formatMeasurement({
            label: 'build time',
            actual: 12.34,
            budget: 180,
            unit: 'seconds',
        });
        expect(line).toBe('build time: 12.3 s (budget 180.0 s) ok');
    });

    it('tracks every packaged artifact the app ships from', () => {
        const paths = SIZE_BUDGETS.map((budget) => budget.path);
        expect(paths).toContain('out/main');
        expect(paths).toContain('apps/server/dist/server');
        expect(paths).toContain('out/preload');
        expect(paths).toContain('out/renderer');
        expect(paths).toContain('release.noindex/mac-arm64/Caxri.app/Contents/Resources/app.asar');
        expect(paths).toContain('release.noindex/mac-arm64/Caxri.app');
    });

    it('keeps both standalone Server copies on the same explicit budget', () => {
        const serverBudgets = SIZE_BUDGETS.filter(({ path }) =>
            [
                'apps/server/dist/server',
                'release.noindex/mac-arm64/Caxri.app/Contents/Resources/server',
            ].includes(path),
        );

        expect(serverBudgets).toHaveLength(2);
        // Asserted as equal to each other rather than to a literal: the two copies are byte-identical by construction,
        // so the contract is that they move together, not that they sit at any particular number.
        expect(new Set(serverBudgets.map(({ maxBytes }) => maxBytes)).size).toBe(1);
    });

    it('detects missing-module stderr from a packaged Node entry', () => {
        const stderr = [
            'node:internal/modules/cjs/loader:1524',
            "Error: Cannot find module '@xterm/addon-serialize'",
            'Require stack:',
        ].join('\n');
        expect(findModuleResolutionFailure(stderr)).toBe(
            "Cannot find module '@xterm/addon-serialize'",
        );
    });

    it('treats expected env-wiring failures as resolution success', () => {
        expect(
            findModuleResolutionFailure('Error: CAXRI_USER_DATA_PATH is required'),
        ).toBeUndefined();
        expect(findModuleResolutionFailure('')).toBeUndefined();
    });

    it('verifies every executable packaged Server entry point', () => {
        expect(PACKAGED_SERVER_ENTRIES).toEqual([
            'bundles/server-core.js',
            'bundles/extension-host.js',
            'bundles/terminal-host.js',
        ]);
    });

    it('stays inside the protected CI retry paths', () => {
        expect(isProtectedRetryPath('scripts/ci-bundle-budget.ts')).toBe(true);
    });

    it('formats signed deltas against the baseline and degrades to n/a', () => {
        expect(formatDeltaPercent(110, 100)).toBe('+10.0%');
        expect(formatDeltaPercent(95, 100)).toBe('-5.0%');
        expect(formatDeltaPercent(100, 100)).toBe('+0.0%');
        expect(formatDeltaPercent(100, undefined)).toBe('n/a');
        expect(formatDeltaPercent(100, 0)).toBe('n/a');
    });

    it('covers every gated artifact in the summary component breakdown', () => {
        const componentPaths = new Set(REPORT_COMPONENTS.map((component) => component.path));
        for (const budget of SIZE_BUDGETS) {
            expect(componentPaths, budget.path).toContain(budget.path);
        }
    });

    it('renders summary rows with budgets, deltas, and the baseline footnote', () => {
        const markdown = buildSummaryMarkdown({
            baseline: {
                commit: 'abcdef1234567890',
                recordedAt: '2026-08-16T00:00:00.000Z',
                seconds: { build: 5 },
                sizes: { 'Caxri.app': 200 * 1_024 * 1_024 },
            },
            commit: '1234567890abcdef',
            components: [
                {
                    budgetBytes: 290 * 1_024 * 1_024,
                    bytes: 220 * 1_024 * 1_024,
                    label: 'Caxri.app',
                },
                { bytes: 10 * 1_024 * 1_024, label: 'out/renderer › fonts' },
            ],
            times: [{ budgetSeconds: 180, label: 'build', seconds: 6 }],
        });
        expect(markdown).toContain('### Bundle budget: `1234567`');
        expect(markdown).toContain('| build | 6.0 s | 180 s | +20.0% |');
        expect(markdown).toContain('| Caxri.app | 220.00 MiB | 290.00 MiB | +10.0% |');
        expect(markdown).toContain('| out/renderer › fonts | 10.00 MiB | \u{2014} | n/a |');
        expect(markdown).toContain('last green `main` build (`abcdef1`');
    });

    it('reports no baseline instead of fabricating deltas', () => {
        const markdown = buildSummaryMarkdown({
            commit: 'deadbeef',
            components: [{ bytes: 1_024, label: 'app.asar' }],
            times: [{ budgetSeconds: 180, label: 'build', seconds: 6 }],
        });
        expect(markdown).toContain('| build | 6.0 s | 180 s | n/a |');
        expect(markdown).toContain('No `main` baseline recorded yet');
    });

    it('keeps positive budgets for both timed phases', () => {
        expect(TIME_BUDGETS.map((budget) => budget.label)).toEqual(['build', 'package']);
        for (const budget of TIME_BUDGETS) {
            expect(budget.maxSeconds).toBeGreaterThan(0);
            expect(budget.command.length).toBeGreaterThan(0);
        }
    });
});

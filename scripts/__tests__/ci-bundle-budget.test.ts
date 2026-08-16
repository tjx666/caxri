import { describe, expect, it } from 'vitest';

import {
    findBudgetViolations,
    findModuleResolutionFailure,
    formatMeasurement,
    PACKAGED_NODE_ENTRIES,
    SIZE_BUDGETS,
    TIME_BUDGETS,
} from '../ci-bundle-budget';
import { isProtectedRetryPath } from '../ci-retry-policy';

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
        expect(paths).toContain('out/preload');
        expect(paths).toContain('out/renderer');
        expect(paths).toContain('release/mac-arm64/Caxri.app/Contents/Resources/app.asar');
        expect(paths).toContain('release/mac-arm64/Caxri.app');
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

    it('verifies both Node-executable packaged entry points', () => {
        expect(PACKAGED_NODE_ENTRIES).toEqual(['out/main/host.js', 'out/main/runtime.js']);
    });

    it('stays inside the protected CI retry paths', () => {
        expect(isProtectedRetryPath('scripts/ci-bundle-budget.ts')).toBe(true);
    });

    it('keeps positive budgets for both timed phases', () => {
        expect(TIME_BUDGETS.map((budget) => budget.label)).toEqual(['build', 'package']);
        for (const budget of TIME_BUDGETS) {
            expect(budget.maxSeconds).toBeGreaterThan(0);
            expect(budget.command.length).toBeGreaterThan(0);
        }
    });
});

import { describe, expect, it } from 'vitest';

import { isPerformanceRelevantPath, isProtectedRetryPath } from '../ci-path-policy';

describe('isPerformanceRelevantPath', () => {
    it('flags the processes the performance baseline can plausibly measure', () => {
        expect(isPerformanceRelevantPath('apps/desktop/src/renderer/src/app.tsx')).toBe(true);
        expect(isPerformanceRelevantPath('apps/desktop/src/main/window.ts')).toBe(true);
        expect(isPerformanceRelevantPath('apps/server/src/core/server-core.ts')).toBe(true);
        expect(isPerformanceRelevantPath('packages/client/src/supervise.ts')).toBe(true);
        expect(
            isPerformanceRelevantPath('packages/protocol/src/transport/renderer-diagnostic.ts'),
        ).toBe(true);
    });

    it('flags a change to the performance E2E specs and the baseline gate itself', () => {
        expect(isPerformanceRelevantPath('e2e/renderer.performance.e2e.ts')).toBe(true);
        expect(isPerformanceRelevantPath('e2e/startup.performance.e2e.ts')).toBe(true);
        expect(isPerformanceRelevantPath('e2e/editor.performance.e2e.ts')).toBe(true);
        expect(isPerformanceRelevantPath('e2e/agent-chat-switch.performance.e2e.ts')).toBe(true);
        expect(isPerformanceRelevantPath('scripts/performance-baseline.ts')).toBe(true);
        expect(isPerformanceRelevantPath('scripts/performance-baseline-gate.ts')).toBe(true);
        expect(isPerformanceRelevantPath('scripts/performance-baseline.json')).toBe(true);
    });

    it('does not flag an unrelated change', () => {
        expect(isPerformanceRelevantPath('docs/README.md')).toBe(false);
        expect(isPerformanceRelevantPath('apps/cli/src/bin.ts')).toBe(false);
        expect(isPerformanceRelevantPath('extensions/git/src/extension.ts')).toBe(false);
        expect(isPerformanceRelevantPath('e2e/smoke.e2e.ts')).toBe(false);
    });

    it('keeps the baseline gate itself protected from an untrusted focused run', () => {
        expect(isProtectedRetryPath('scripts/performance-baseline-gate.ts')).toBe(true);
        expect(isProtectedRetryPath('scripts/performance-baseline.json')).toBe(true);
    });
});

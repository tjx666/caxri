import { describe, expect, it } from 'vitest';

import {
    ownedProcessIds,
    parseProcessTable,
    protectedProcessIds,
    validateRunnerOwner,
} from './self-hosted-e2e-runner';

describe('self-hosted E2E runner ownership', () => {
    const processes = parseProcessTable(`
  1   0 launchd
100   1 runner
110 100 bash CAXRI_E2E_RUN_OWNER=caxri-42-1-control
120 110 bun CAXRI_E2E_RUN_OWNER=caxri-42-1-control
130 100 Electron CAXRI_E2E_RUN_OWNER=caxri-41-1-control
140 100 Electron CAXRI_E2E_RUN_OWNER=caxri-42-1-control-extra
`);

    it('protects the cleanup process ancestry and selects only the exact run owner', () => {
        expect([...protectedProcessIds(processes, 120)]).toEqual([120, 110, 100, 1]);
        expect(
            ownedProcessIds(processes, 'caxri-42-1-control', protectedProcessIds(processes, 120)),
        ).toEqual([]);
        expect(ownedProcessIds(processes, 'caxri-42-1-control', new Set([110]))).toEqual([120]);
    });

    it('accepts only bounded portable run owners', () => {
        expect(validateRunnerOwner('caxri-123-2-parallel-safe')).toBe('caxri-123-2-parallel-safe');
        expect(() => validateRunnerOwner('caxri-123-2-../../home')).toThrow(
            'Invalid CAXRI_E2E_RUN_OWNER',
        );
    });
});

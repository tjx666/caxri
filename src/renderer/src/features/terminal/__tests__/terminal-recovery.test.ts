import { describe, expect, it } from 'vitest';

import { shouldReconcileTerminalRecovery } from '../terminal-recovery';

describe('shouldReconcileTerminalRecovery', () => {
    it('reconciles once whenever a mounted Terminal becomes live', () => {
        expect(shouldReconcileTerminalRecovery('interrupted', 'running')).toBe(true);
        expect(shouldReconcileTerminalRecovery('starting', 'running')).toBe(true);
        expect(shouldReconcileTerminalRecovery('stopped', 'running')).toBe(true);
        expect(shouldReconcileTerminalRecovery('running', 'running')).toBe(false);
        expect(shouldReconcileTerminalRecovery('interrupted', 'failed')).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';

import { terminalMemoryLabel } from '../terminal-memory-label';

describe('terminalMemoryLabel', () => {
    it('keeps small readings in MB with one decimal', () => {
        expect(terminalMemoryLabel(45.2)).toBe('45.2 MB');
        expect(terminalMemoryLabel(662)).toBe('662.0 MB');
    });

    it('falls back to whole bytes for a reading below 1 MB', () => {
        expect(terminalMemoryLabel(0)).toBe('0 B');
    });

    it('rolls a reading past 1024 MB into GB instead of printing four-digit MB', () => {
        expect(terminalMemoryLabel(2_402.8)).toBe('2.3 GB');
        expect(terminalMemoryLabel(1_024)).toBe('1.0 GB');
    });
});

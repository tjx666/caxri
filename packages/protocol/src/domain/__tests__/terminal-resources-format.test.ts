import { describe, expect, it } from 'vitest';

import { formatCpuPercent, formatMemoryMb } from '../terminal-resources';

describe('formatMemoryMb', () => {
    it('keeps small readings in MB with one decimal', () => {
        expect(formatMemoryMb(45.2)).toBe('45.2 MB');
        expect(formatMemoryMb(662)).toBe('662.0 MB');
    });

    it('falls back to whole bytes for a reading below 1 MB', () => {
        expect(formatMemoryMb(0)).toBe('0 B');
    });

    it('rolls a reading past 1024 MB into GB instead of printing four-digit MB', () => {
        expect(formatMemoryMb(2_402.8)).toBe('2.3 GB');
        expect(formatMemoryMb(1_024)).toBe('1.0 GB');
    });
});

describe('formatCpuPercent', () => {
    it('keeps one decimal below 10% and whole percent above', () => {
        expect(formatCpuPercent(0)).toBe('0.0%');
        expect(formatCpuPercent(9.54)).toBe('9.5%');
        expect(formatCpuPercent(396.2)).toBe('396%');
    });
});

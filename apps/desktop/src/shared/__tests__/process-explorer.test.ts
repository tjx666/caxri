import { describe, expect, it } from 'vitest';

import { processExplorerSnapshotSchema } from '../process-explorer';

function makeEntry(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        pid: 100,
        parentPid: 1,
        name: 'agent',
        kind: 'process',
        cpuPercent: 0,
        memoryMb: 0,
        ...overrides,
    };
}

/**
 * Validates a single process entry against the full snapshot schema, keeping call nesting shallow in individual
 * assertions below.
 */
function isValidEntry(overrides: Partial<Record<string, unknown>>): boolean {
    const snapshot = {
        processes: [makeEntry(overrides)],
        terminals: [],
        systemMemoryMb: 0,
        sampledAt: Date.now(),
    };
    return processExplorerSnapshotSchema.safeParse(snapshot).success;
}

function isValidProcessCount(count: number): boolean {
    const entries = Array.from({ length: count }, (_unused, index) =>
        makeEntry({ pid: index + 1 }),
    );
    const snapshot = {
        processes: entries,
        terminals: [],
        systemMemoryMb: 0,
        sampledAt: Date.now(),
    };
    return processExplorerSnapshotSchema.safeParse(snapshot).success;
}

describe('processExplorerSnapshotSchema', () => {
    it('accepts a minimal valid snapshot', () => {
        expect(isValidEntry({})).toBe(true);
    });

    it('accepts an empty process list', () => {
        const snapshot = { processes: [], terminals: [], systemMemoryMb: 0, sampledAt: Date.now() };
        expect(processExplorerSnapshotSchema.safeParse(snapshot).success).toBe(true);
    });

    it('rejects a non-positive pid', () => {
        expect(isValidEntry({ pid: 0 })).toBe(false);
        expect(isValidEntry({ pid: -1 })).toBe(false);
    });

    it('rejects a non-integer pid', () => {
        expect(isValidEntry({ pid: 1.5 })).toBe(false);
    });

    it('accepts a zero parentPid but rejects a negative one', () => {
        expect(isValidEntry({ parentPid: 0 })).toBe(true);
        expect(isValidEntry({ parentPid: -1 })).toBe(false);
    });

    it('rejects an empty process name', () => {
        expect(isValidEntry({ name: '' })).toBe(false);
    });

    it('accepts a process name exactly at the 4096-character cap', () => {
        expect(isValidEntry({ name: 'a'.repeat(4_096) })).toBe(true);
    });

    it('rejects a process name past the 4096-character cap', () => {
        expect(isValidEntry({ name: 'a'.repeat(4_097) })).toBe(false);
    });

    it('rejects negative cpuPercent or memoryMb', () => {
        expect(isValidEntry({ cpuPercent: -0.1 })).toBe(false);
        expect(isValidEntry({ memoryMb: -1 })).toBe(false);
    });

    it('accepts a process list exactly at the 2048-entry cap', () => {
        expect(isValidProcessCount(2_048)).toBe(true);
    });

    it('rejects a process list past the 2048-entry cap', () => {
        expect(isValidProcessCount(2_049)).toBe(false);
    });
});

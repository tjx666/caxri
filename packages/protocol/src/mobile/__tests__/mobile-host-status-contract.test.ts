import { describe, expect, it } from 'vitest';

import type {
    HostSessionLoadSample,
    HostStatusSample,
    MobileHostProcess,
} from '../mobile-host-status-contract';
import {
    MOBILE_HOST_STATUS_MAX_BYTES,
    MOBILE_HOST_STATUS_MAX_TERMINALS_PER_SESSION,
    MOBILE_HOST_STATUS_TITLE_MAX_LENGTH,
    MOBILE_HOST_STATUS_TOP_PROCESSES,
    mobileHostStatusSchema,
    projectHostStatusForMobile,
} from '../mobile-host-status-contract';

const system = {
    cpuPercent: 42.5,
    cpuCount: 10,
    loadAverage: [3.1, 2.4, 2] as [number, number, number],
    memoryTotalMb: 32_768,
    memoryUsedMb: 20_480,
    swapUsedMb: 512,
    uptimeSeconds: 86_400,
};

const session = (index: number, cpuPercent: number, terminals = 1): HostSessionLoadSample => ({
    sessionId: `session-${index}`,
    title: `Session ${index}`,
    cpuPercent,
    memoryMb: 100 * index,
    processCount: terminals * 3,
    terminals: Array.from({ length: terminals }, (_, terminal) => ({
        terminalId: `terminal-${index}-${terminal}`,
        kind: 'claude' as const,
        provider: 'claude' as const,
        title: `Claude ${terminal}`,
        cpuPercent: terminal,
        memoryMb: 50,
        processCount: 3,
    })),
});

const process = (pid: number, cpuPercent: number, memoryMb: number): MobileHostProcess => ({
    pid,
    name: `process-${pid}`,
    cpuPercent,
    memoryMb,
});

const sample = (
    overrides: Partial<NonNullable<HostStatusSample['processes']>>,
): HostStatusSample => ({
    sampledAt: 1,
    system,
    processes: { services: [], sessions: [], all: [], ...overrides },
});

describe('projectHostStatusForMobile', () => {
    it('keeps the system figures when the process table is unavailable', () => {
        const status = projectHostStatusForMobile({ sampledAt: 1, system });
        expect(status).toEqual({ sampledAt: 1, system });
        expect(mobileHostStatusSchema.parse(status)).toEqual(status);
    });

    it('orders Sessions busiest first and their Terminals busiest first, capped per Session', () => {
        const status = projectHostStatusForMobile(
            sample({ sessions: [session(1, 5), session(2, 80, 12), session(3, 20)] }),
        );
        const sessions = status.processes?.sessions ?? [];
        expect(sessions.map((entry) => entry.sessionId)).toEqual([
            'session-2',
            'session-3',
            'session-1',
        ]);
        expect(sessions[0].terminals).toHaveLength(MOBILE_HOST_STATUS_MAX_TERMINALS_PER_SESSION);
        expect(sessions[0].terminals[0].cpuPercent).toBe(11);
        expect(sessions[0].terminalTotal).toBe(12);
        expect(mobileHostStatusSchema.parse(status)).toEqual(status);
    });

    it('carries the top processes by CPU and by memory without duplicates', () => {
        const all = [
            ...Array.from({ length: 30 }, (_, index) => process(index + 1, index, 1)),
            process(100, 0, 9_000),
            process(101, 29, 8_000),
        ];
        const top = projectHostStatusForMobile(sample({ all })).processes?.topProcesses ?? [];
        expect(top.length).toBeLessThanOrEqual(MOBILE_HOST_STATUS_TOP_PROCESSES * 2);
        expect(new Set(top.map((entry) => entry.pid)).size).toBe(top.length);
        expect(top.map((entry) => entry.pid)).toEqual(expect.arrayContaining([30, 101, 100]));
    });

    it('cuts long titles and fits a crowded Mac into one frame, reporting the total', () => {
        const long = 'x'.repeat(500);
        const sessions = Array.from({ length: 200 }, (_, index) => ({
            ...session(index + 1, index, 8),
            title: long,
        }));
        const status = projectHostStatusForMobile(sample({ sessions }));
        expect(status.processes?.sessionTotal).toBe(200);
        expect(status.processes?.sessions.length).toBeLessThan(200);
        expect(status.processes?.sessions[0].title).toHaveLength(
            MOBILE_HOST_STATUS_TITLE_MAX_LENGTH + 1,
        );
        expect(new TextEncoder().encode(JSON.stringify(status)).length).toBeLessThanOrEqual(
            MOBILE_HOST_STATUS_MAX_BYTES,
        );
        expect(mobileHostStatusSchema.parse(status)).toEqual(status);
    });
});

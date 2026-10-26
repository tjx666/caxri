import type { MobileHostSessionLoad, MobileHostSystem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    formatUptime,
    hostStatusScreenState,
    meterLevel,
    serviceRows,
    sessionRows,
    systemModel,
    topProcessRows,
} from '../host-status-model';

const system: MobileHostSystem = {
    cpuPercent: 82.4,
    cpuCount: 10,
    loadAverage: [3.25, 2.5, 2],
    memoryTotalMb: 32_768,
    memoryUsedMb: 30_720,
    swapUsedMb: 512,
    uptimeSeconds: 3 * 86_400 + 4 * 3600 + 120,
};

const session = (overrides: Partial<MobileHostSessionLoad> = {}): MobileHostSessionLoad => ({
    sessionId: 'session-1',
    title: 'Fix login',
    cpuPercent: 320,
    memoryMb: 2_048,
    processCount: 6,
    terminals: [
        {
            terminalId: 'terminal-agent',
            kind: 'claude',
            provider: 'claude',
            title: 'claude',
            cpuPercent: 310,
            memoryMb: 1_900,
            processCount: 5,
        },
        {
            terminalId: 'terminal-shell',
            kind: 'shell',
            title: '',
            cpuPercent: 10,
            memoryMb: 148,
            processCount: 1,
        },
    ],
    terminalTotal: 3,
    ...overrides,
});

describe('host status model', () => {
    it('keeps the last reading on screen when offline or a refresh fails', () => {
        expect(
            hostStatusScreenState({ hasData: false, isError: false, isObservable: true }),
        ).toEqual({
            kind: 'loading',
        });
        expect(
            hostStatusScreenState({ hasData: false, isError: true, isObservable: true }),
        ).toEqual({
            kind: 'error',
        });
        expect(
            hostStatusScreenState({ hasData: false, isError: false, isObservable: false }),
        ).toEqual({ kind: 'offline' });
        expect(hostStatusScreenState({ hasData: true, isError: true, isObservable: true })).toEqual(
            {
                kind: 'ready',
                isStale: false,
                hasRefreshError: true,
            },
        );
        expect(
            hostStatusScreenState({ hasData: true, isError: false, isObservable: false }),
        ).toEqual({ kind: 'ready', isStale: true, hasRefreshError: false });
    });

    it('reads system CPU and memory as meters that warn when nearly full', () => {
        const model = systemModel(system);
        expect(model.cpu).toMatchObject({
            level: 'warning',
            value: '82%',
            detail: '10 cores · load 3.25 · 2.50 · 2.00',
        });
        expect(model.cpu.ratio).toBeCloseTo(0.824);
        expect(model.memory).toMatchObject({
            level: 'danger',
            value: '30.0 GB of 32.0 GB',
            detail: 'Swap 512.0 MB',
        });
        expect(model.uptime).toBe('Up 3d 4h');
        expect(systemModel({ ...system, cpuPercent: undefined }).cpu).toMatchObject({
            ratio: null,
            value: '—',
        });
        expect(meterLevel(0.5)).toBe('normal');
    });

    it('formats uptime at the coarsest useful unit', () => {
        expect(formatUptime(59)).toBe('0m');
        expect(formatUptime(2 * 3600 + 5 * 60)).toBe('2h 5m');
    });

    it('flags a Session whose Terminal crosses the shared alert thresholds and names Terminals like Desktop', () => {
        const [row] = sessionRows([session()]);
        expect(row).toMatchObject({
            id: 'session-1',
            title: 'Fix login',
            isHigh: true,
            kind: 'claude',
            cpu: '320%',
            memory: '2.0 GB',
            processes: '6 processes',
            hiddenTerminals: 1,
        });
        expect(row.terminals.map((terminal) => [terminal.name, terminal.isHigh])).toEqual([
            ['Claude', true],
            ['Terminal', false],
        ]);
        const [quiet] = sessionRows([
            session({ title: '', terminals: [session().terminals[1]], terminalTotal: 1 }),
        ]);
        expect(quiet).toMatchObject({
            title: 'Untitled Session',
            isHigh: false,
            hiddenTerminals: 0,
        });
    });

    it('orders Caxri services and sorts top processes by the chosen column', () => {
        expect(
            serviceRows([
                { role: 'extensionHost', pid: 3, cpuPercent: 0, memoryMb: 50 },
                { role: 'serverCore', pid: 1, cpuPercent: 1, memoryMb: 200 },
            ]).map((row) => row.name),
        ).toEqual(['Server Core', 'Extension Host']);
        const processes = [
            { pid: 1, name: 'claude', cpuPercent: 90, memoryMb: 500 },
            { pid: 2, name: 'Browser', cpuPercent: 5, memoryMb: 4_000 },
            { pid: 3, name: 'node', cpuPercent: 40, memoryMb: 100 },
        ];
        expect(topProcessRows(processes, 'cpu').map((row) => row.name)).toEqual([
            'claude',
            'node',
            'Browser',
        ]);
        expect(topProcessRows(processes, 'memory', 2).map((row) => row.name)).toEqual([
            'Browser',
            'claude',
        ]);
    });
});

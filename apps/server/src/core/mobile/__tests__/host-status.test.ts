import type os from 'node:os';

import type { TerminalProcessEntry } from '@caxri/protocol';
import { CpuUsageMeter, parseProcessTableWithCommands, ProcessTable } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { HostStatusSampler, namedProcesses, serviceLoads, sessionLoads } from '../host-status';
import { isMobileGatewayMethodAllowedForRole } from '../role-methods';

const SERVER_PID = 100;
const PS = [
    `  ${SERVER_PID}     1   2.0  204800 /app/runtime/bin/node /app/bundles/server.js`,
    '  101   100   1.0  102400 /app/runtime/bin/node --inspect=9231 /app/bundles/terminal-host.js',
    '  102   100   0.5   51200 /app/runtime/bin/node /app/bundles/extension-host.js',
    '  200   101   0.0    2048 -zsh',
    '  201   200 150.0 2097152 /Users/me/.local/bin/claude --api-key sk-secret --resume abc',
    '  202   201  60.0  524288 node /tmp/tool.js',
    '  300   101   1.0    4096 /bin/zsh -l',
    '  400     1  10.0   10240 /Applications/Browser.app/Contents/MacOS/Browser',
    '  500   100   0.0    1024 /bin/ps -axo pid=,ppid=,pcpu=,rss=,command=',
].join('\n');

const table = () => new ProcessTable(parseProcessTableWithCommands(PS));

const terminal = (
    terminalId: string,
    sessionId: string,
    processId: number,
    provider?: 'claude',
): TerminalProcessEntry => ({
    terminalId,
    sessionId,
    sessionTitle: `Title ${sessionId}`,
    kind: provider ?? 'shell',
    ...(provider && { provider }),
    title: provider ? 'Claude' : 'zsh',
    processId,
});

const cpus = (busy: number, idle: number): os.CpuInfo[] => [
    { model: 'test', speed: 0, times: { idle, irq: 0, nice: 0, sys: 0, user: busy } },
];

const memory = () => Promise.resolve({ totalMb: 32_768, usedMb: 16_384, swapUsedMb: 0 });
const system = () => ({
    cpuCount: 10,
    loadAverage: [1, 2, 3] as [number, number, number],
    uptimeSeconds: 60,
});

describe('computer status sampling', () => {
    it("sums each running Terminal's process tree into its Session", () => {
        const sessions = sessionLoads(table(), [
            terminal('t-agent', 's-1', 200, 'claude'),
            terminal('t-shell', 's-1', 300),
            terminal('t-exited', 's-2', 999),
        ]);
        expect(sessions).toEqual([
            {
                sessionId: 's-1',
                title: 'Title s-1',
                cpuPercent: 211,
                memoryMb: 2566,
                processCount: 4,
                terminals: [
                    expect.objectContaining({
                        terminalId: 't-agent',
                        provider: 'claude',
                        cpuPercent: 210,
                        memoryMb: 2562,
                        processCount: 3,
                    }),
                    expect.objectContaining({ terminalId: 't-shell', processCount: 1 }),
                ],
            },
        ]);
    });

    it('lists Server Core and its hosts by their own process only', () => {
        expect(serviceLoads(table(), SERVER_PID)).toEqual([
            { role: 'serverCore', pid: 100, cpuPercent: 2, memoryMb: 200 },
            { role: 'terminalHost', pid: 101, cpuPercent: 1, memoryMb: 100 },
            { role: 'extensionHost', pid: 102, cpuPercent: 0.5, memoryMb: 50 },
        ]);
    });

    it('names processes by executable only, so no argument leaves the Mac', () => {
        const processes = namedProcesses(table());
        expect(processes.find((entry) => entry.pid === 201)?.name).toBe('claude');
        expect(processes.find((entry) => entry.pid === 202)?.name).toBe('node tool.js');
        expect(processes.some((entry) => entry.pid === 500)).toBe(false);
        expect(JSON.stringify(processes)).not.toContain('sk-secret');
    });

    it('shares one sample between concurrent phones and refreshes after the shared window', async () => {
        let now = 0;
        const sampleProcessTable = vi.fn(() => Promise.resolve(table()));
        const reads = [cpus(0, 0), cpus(50, 50), cpus(100, 100)];
        const sampler = new HostStatusSampler({
            cpuBaselineGapMs: 0,
            cpuMeter: new CpuUsageMeter(() => reads.shift() ?? cpus(100, 100)),
            now: () => now,
            sampleProcessTable,
            sampleSystemMemory: memory,
            serverPid: SERVER_PID,
            system,
            terminals: () => Promise.resolve([terminal('t-agent', 's-1', 200, 'claude')]),
        });
        const [first, second] = await Promise.all([sampler.status(), sampler.status()]);
        expect(first).toBe(second);
        expect(sampleProcessTable).toHaveBeenCalledTimes(1);
        expect(first.system).toEqual({
            cpuPercent: 50,
            cpuCount: 10,
            loadAverage: [1, 2, 3],
            memoryTotalMb: 32_768,
            memoryUsedMb: 16_384,
            swapUsedMb: 0,
            uptimeSeconds: 60,
        });
        expect(first.processes?.sessions.map((session) => session.sessionId)).toEqual(['s-1']);
        expect(first.processes?.services).toHaveLength(3);
        now = 2_000;
        const next = await sampler.status();
        expect(sampleProcessTable).toHaveBeenCalledTimes(2);
        // 50 busy out of 100 elapsed since the previous read, with no fresh baseline because it is recent.
        expect(next.system.cpuPercent).toBe(50);
    });

    it('serves system figures when ps fails and logs each failing part once', async () => {
        let now = 0;
        const write = vi.fn();
        const sampler = new HostStatusSampler({
            cpuBaselineGapMs: 0,
            logger: { write },
            now: () => now,
            sampleProcessTable: () => Promise.reject(new Error('ps timed out')),
            sampleSystemMemory: memory,
            system,
            terminals: () => Promise.reject(new Error('Server Core restarting')),
        });
        const status = await sampler.status();
        expect(status.processes).toBeUndefined();
        expect(status.system.memoryUsedMb).toBe(16_384);
        now = 5_000;
        await sampler.status();
        const parts = write.mock.calls.map(
            (call) => (call[2] as { fields: { part: string } }).fields.part,
        );
        expect(parts.toSorted((left, right) => left.localeCompare(right))).toEqual([
            'processTable',
            'terminals',
        ]);
    });

    it('keeps Session load empty but the rest of the reply when the Terminal list fails', async () => {
        const sampler = new HostStatusSampler({
            cpuBaselineGapMs: 0,
            sampleProcessTable: () => Promise.resolve(table()),
            sampleSystemMemory: memory,
            serverPid: SERVER_PID,
            system,
            terminals: () => Promise.reject(new Error('unavailable')),
        });
        const status = await sampler.status();
        expect(status.processes?.sessions).toEqual([]);
        expect(status.processes?.topProcesses[0].name).toBe('claude');
    });

    it('admits only control devices, because it names Sessions from every Project', () => {
        expect(isMobileGatewayMethodAllowedForRole('view', 'mobile.host.status')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('reply', 'mobile.host.status')).toBe(false);
        expect(isMobileGatewayMethodAllowedForRole('control', 'mobile.host.status')).toBe(true);
    });
});

import type os from 'node:os';

import { describe, expect, it } from 'vitest';

import { parseProcessTableWithCommands, ProcessTable } from '../process-table';
import {
    CpuUsageMeter,
    parseMeminfo,
    parseSwapUsageBytes,
    parseVmStatUsedBytes,
} from '../system-resources';

const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  1723633.
Pages active:                                2978413.
Pages wired down:                             345221.
Pages purgeable:                               69178.
"Translation faults":                     2108263694.
File-backed pages:                           2332234.
Anonymous pages:                             3848423.
Pages occupied by compressor:                  80093.
`;

const cpu = (busy: number, idle: number): os.CpuInfo => ({
    model: 'test',
    speed: 0,
    times: { idle, irq: 0, nice: 0, sys: 0, user: busy },
});

describe('system resources', () => {
    it('reads Activity Monitor memory used from vm_stat, excluding purgeable and file cache', () => {
        expect(parseVmStatUsedBytes(VM_STAT)).toBe(
            (3_848_423 - 69_178 + 345_221 + 80_093) * 16_384,
        );
        expect(parseVmStatUsedBytes('Pages free: 1.')).toBeUndefined();
        expect(parseVmStatUsedBytes(VM_STAT.replace('Anonymous pages', 'Other'))).toBeUndefined();
    });

    it('reads swap in use from sysctl vm.swapusage in any unit', () => {
        expect(
            parseSwapUsageBytes('total = 2048.00M  used = 1018.25M  free = 1029.75M  (encrypted)'),
        ).toBe(1018.25 * 1024 * 1024);
        expect(parseSwapUsageBytes('total = 4.00G  used = 1.50G  free = 2.50G')).toBe(
            1.5 * 1024 ** 3,
        );
        expect(parseSwapUsageBytes('unexpected')).toBeUndefined();
    });

    it('reads Linux memory and swap from /proc/meminfo', () => {
        expect(
            parseMeminfo(
                'MemTotal:       16000 kB\nMemFree: 1000 kB\nMemAvailable:    6000 kB\nSwapTotal: 2000 kB\nSwapFree: 500 kB\n',
            ),
        ).toEqual({
            totalBytes: 16_000 * 1024,
            usedBytes: 10_000 * 1024,
            swapUsedBytes: 1500 * 1024,
        });
        expect(parseMeminfo('MemTotal: 1 kB\n')).toBeUndefined();
    });

    it('reports CPU busy share across all cores between two reads', () => {
        const reads = [
            [cpu(100, 900), cpu(100, 900)],
            [cpu(400, 1600), cpu(100, 1900)],
        ];
        const meter = new CpuUsageMeter(() => reads.shift() ?? []);
        expect(meter.sample()).toBeUndefined();
        // 300 + 0 busy out of 1000 + 1000 elapsed.
        expect(meter.sample()).toBe(15);
    });

    it('keeps each command line when sampling with commands', () => {
        const table = new ProcessTable(
            parseProcessTableWithCommands(
                '  10     1  12.5  2048 /usr/bin/claude --resume abc\n  11    10   0.0  1024 (git)\nbad line\n',
            ),
        );
        expect(table.get(10)).toEqual({
            pid: 10,
            parentPid: 1,
            cpuPercent: 12.5,
            rssKb: 2048,
            command: '/usr/bin/claude --resume abc',
        });
        expect(table.entries()).toHaveLength(2);
        expect(table.usage(10)).toEqual({ cpuPercent: 12.5, memoryMb: 3, processCount: 2 });
    });
});

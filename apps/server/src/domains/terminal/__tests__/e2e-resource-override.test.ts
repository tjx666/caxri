import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
    applyTerminalResourceOverride,
    resolveE2ETerminalResourceOverride,
} from '../e2e-resource-override';

const directories: string[] = [];

async function overrideFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-resource-override-'));
    directories.push(directory);
    return join(directory, 'override.json');
}

afterEach(async () => {
    await Promise.all(
        directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
    directories.length = 0;
});

describe('resolveE2ETerminalResourceOverride', () => {
    it('ignores the seam outside an explicit E2E launch', () => {
        expect(
            resolveE2ETerminalResourceOverride({
                CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE: '/tmp/override.json',
            }),
        ).toBeUndefined();
        expect(resolveE2ETerminalResourceOverride({ CAXRI_E2E: '1' })).toBeUndefined();
    });

    it('fails closed on a relative path', () => {
        expect(() =>
            resolveE2ETerminalResourceOverride({
                CAXRI_E2E: '1',
                CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE: 'override.json',
            }),
        ).toThrow('absolute path');
    });

    it('re-reads the file on every sample and treats an absent file as no override', async () => {
        const path = await overrideFile();
        const seam = resolveE2ETerminalResourceOverride({
            CAXRI_E2E: '1',
            CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE: path,
        });
        expect(seam?.intervalMs).toBe(1_000);
        expect(await seam?.read('terminal-1')).toBeUndefined();
        await writeFile(path, JSON.stringify({ 'terminal-1': { cpuPercent: 350 } }));
        expect(await seam?.read('terminal-1')).toEqual({ cpuPercent: 350 });
        expect(await seam?.read('terminal-2')).toBeUndefined();
        await writeFile(path, '{}');
        expect(await seam?.read('terminal-1')).toBeUndefined();
        await writeFile(path, JSON.stringify({ 'terminal-1': { cpuPercent: -1 } }));
        await expect(seam?.read('terminal-1')).rejects.toThrow();
    });
});

describe('applyTerminalResourceOverride', () => {
    const usage = { cpuPercent: 1, memoryMb: 20, childProcessCount: 2 };

    it('replaces only the injected readings and keeps the real process count', () => {
        expect(applyTerminalResourceOverride(usage, { cpuPercent: 350 })).toEqual({
            cpuPercent: 350,
            memoryMb: 20,
            childProcessCount: 2,
        });
        expect(applyTerminalResourceOverride(usage, undefined)).toBe(usage);
    });

    it('never invents a reading for an exited tree', () => {
        expect(applyTerminalResourceOverride(null, { cpuPercent: 350 })).toBeNull();
    });
});

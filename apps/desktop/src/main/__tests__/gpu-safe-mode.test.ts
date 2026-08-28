import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    createGpuSafeModeController,
    gpuSafeModeStatePath,
    readGpuSafeModeAtBoot,
} from '../gpu-safe-mode';

function createUserDataDirectory(): string {
    return mkdtempSync(join(tmpdir(), 'caxri-gpu-safe-mode-'));
}

describe('GPU Safe Mode circuit breaker', () => {
    it('activates only after two code 34 incidents inside the rolling 24-hour window', async () => {
        const userDataPath = createUserDataDirectory();
        let now = Date.UTC(2026, 7, 28, 8);
        const controller = createGpuSafeModeController({ now: () => now, userDataPath });

        await expect(controller.recordContextLoss('incident-1')).resolves.toMatchObject({
            activated: false,
            count: 1,
        });
        now += 23 * 60 * 60 * 1_000;
        await expect(controller.recordContextLoss('incident-2')).resolves.toMatchObject({
            activated: true,
            count: 2,
            correlationId: 'incident-2',
        });

        expect(readGpuSafeModeAtBoot(userDataPath)).toMatchObject({
            active: true,
            automatic: true,
            correlationId: 'incident-2',
        });
    });

    it('prunes stale incidents and ignores unrelated child exits at its typed boundary', async () => {
        const userDataPath = createUserDataDirectory();
        let now = Date.UTC(2026, 7, 28, 8);
        const controller = createGpuSafeModeController({ now: () => now, userDataPath });

        await controller.recordContextLoss('incident-old');
        now += 24 * 60 * 60 * 1_000 + 1;
        await expect(controller.recordContextLoss('incident-current')).resolves.toMatchObject({
            activated: false,
            count: 1,
        });
    });

    it('clears the automatic marker and history when the user re-enables hardware acceleration', async () => {
        const userDataPath = createUserDataDirectory();
        const controller = createGpuSafeModeController({ now: () => 100, userDataPath });
        await controller.recordContextLoss('incident-1');
        await controller.recordContextLoss('incident-2');

        await controller.clear();

        expect(readGpuSafeModeAtBoot(userDataPath)).toEqual({
            active: false,
            automatic: false,
        });
    });

    it('keeps the automatic marker when re-enabling hardware acceleration cannot update argv', async () => {
        const userDataPath = createUserDataDirectory();
        const updateBootConfig = vi.fn(
            (_path: string, changes: { hardwareAcceleration?: boolean }) => {
                if (changes.hardwareAcceleration === true)
                    return Promise.reject(new Error('argv unavailable'));
                return Promise.resolve({ hardwareAcceleration: false, remoteDebugging: true });
            },
        );
        const controller = createGpuSafeModeController({
            now: () => 100,
            updateBootConfig,
            userDataPath,
        });
        await controller.recordContextLoss('incident-1');
        await controller.recordContextLoss('incident-2');

        await expect(controller.updateArgvConfig({ hardwareAcceleration: true })).rejects.toThrow(
            'argv unavailable',
        );

        expect(readGpuSafeModeAtBoot(userDataPath)).toMatchObject({
            active: true,
            automatic: true,
            correlationId: 'incident-2',
        });
    });

    it('keeps an activated automatic marker until the user explicitly re-enables acceleration', async () => {
        const userDataPath = createUserDataDirectory();
        let now = Date.UTC(2026, 7, 28, 8);
        const controller = createGpuSafeModeController({ now: () => now, userDataPath });
        await controller.recordContextLoss('incident-1');
        await controller.recordContextLoss('incident-2');

        now += 25 * 60 * 60 * 1_000;

        expect(readGpuSafeModeAtBoot(userDataPath)).toMatchObject({
            active: true,
            automatic: true,
            correlationId: 'incident-2',
        });
    });

    it('fails closed on unknown or sensitive persisted fields without surfacing their values', () => {
        const userDataPath = createUserDataDirectory();
        const path = gpuSafeModeStatePath(userDataPath);
        mkdirSync(join(userDataPath, 'config'), { recursive: true });
        writeFileSync(
            path,
            JSON.stringify({
                version: 1,
                automatic: true,
                correlationId: 'incident-1',
                incidents: [],
                terminalOutput: 'secret prompt',
                environment: { TOKEN: 'credential' },
            }),
        );

        expect(readGpuSafeModeAtBoot(userDataPath)).toEqual({
            active: false,
            automatic: false,
        });
        expect(readFileSync(path, 'utf8')).toContain('secret prompt');
    });
});

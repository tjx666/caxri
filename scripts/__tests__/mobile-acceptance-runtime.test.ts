import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assertMobileAcceptanceSourceIdentity,
    runMobileAcceptanceCommand,
    writeMobileAcceptanceReceipt,
} from '../mobile-acceptance-runtime';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const directories = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(directories.map((directory) => rm(directory, { recursive: true })));
});

describe('mobile Acceptance runtime', () => {
    it('rejects a different or dirty source tree before device work starts', () => {
        expect(() =>
            assertMobileAcceptanceSourceIdentity({
                actualCommit: 'b'.repeat(40),
                plannedCommit: 'a'.repeat(40),
                status: '',
            }),
        ).toThrow('does not match the frozen report commit');
        expect(() =>
            assertMobileAcceptanceSourceIdentity({
                actualCommit: 'a'.repeat(40),
                plannedCommit: 'a'.repeat(40),
                status: ' M scripts/mobile-android-acceptance.ts',
            }),
        ).toThrow('requires a clean source tree');
    });

    it('bounds every child command by both its stage and overall deadlines', () => {
        const spawn = vi.fn(() => ({ error: undefined, status: 0 }));
        runMobileAcceptanceCommand(
            {
                arguments: ['run', 'build'],
                command: 'bun',
                cwd: '/repo',
                deadlineMs: 11_000,
                nowMs: 1_000,
                timeoutMs: 30_000,
            },
            spawn as never,
        );
        expect(spawn).toHaveBeenCalledWith(
            'bun',
            ['run', 'build'],
            expect.objectContaining({ timeout: 10_000, killSignal: 'SIGTERM' }),
        );
    });

    it('atomically replaces a prior launch receipt during a clean retry', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-acceptance-'));
        temporaryDirectories.push(directory);
        const path = join(directory, 'receipt.json');
        await writeMobileAcceptanceReceipt(path, { launchId: 'launch-1', status: 'failed' });
        await writeMobileAcceptanceReceipt(path, { launchId: 'launch-2', status: 'passed' });

        await expect(readFile(path, 'utf8')).resolves.toContain('launch-2');
        await expect(readFile(path, 'utf8')).resolves.not.toContain('launch-1');
    });
});

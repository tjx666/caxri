import type { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { createInitialState } from '../state-model';
import { withStateLock, writeInitialState } from '../state-storage';

describe('Go state writer lock', () => {
    it('fails closed when another process owns the lock', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-lock-'));
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Serialize writers', runId: 'writer-lock' });
        let release!: () => void;
        let entered!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const acquired = new Promise<void>((resolve) => (entered = resolve));
        try {
            await writeInitialState(path, state);
            const owner = withStateLock(path, async () => {
                entered();
                await held;
            });
            await acquired;

            await expect(withStateLock(path, () => Promise.resolve())).rejects.toThrow(
                'already locked by another writer',
            );
            release();
            await owner;
            await expect(access(join(directory, 'state.lock'))).rejects.toThrow();
        } finally {
            release();
            await rm(directory, { force: true, recursive: true });
        }
    });

    it('reclaims the lock after its owning process is SIGKILLed', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-go-stale-lock-'));
        const path = join(directory, 'state.json');
        const state = createInitialState({ objective: 'Recover writer lock', runId: 'stale-lock' });
        await writeInitialState(path, state);
        const storageUrl = new URL('../state-storage.ts', import.meta.url).href;
        const owner = spawn(
            'bun',
            [
                '-e',
                `const { withStateLock } = await import(${JSON.stringify(storageUrl)}); await withStateLock(${JSON.stringify(path)}, async () => { console.log('locked'); await new Promise(() => setInterval(() => {}, 1000)); });`,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const ownerPid = owner.pid;
        if (!ownerPid) throw new Error('State lock owner fixture did not start');
        let ownerStderr = '';
        let isOwnerAcquired = false;
        const {
            promise: acquired,
            reject: rejectAcquired,
            resolve: releaseAcquired,
        } = Promise.withResolvers<void>();
        owner.stdout.once('data', () => {
            isOwnerAcquired = true;
            releaseAcquired();
        });
        owner.stderr.on('data', (chunk: Buffer) => (ownerStderr += chunk.toString()));
        const closed = new Promise<void>((resolve) => {
            owner.once('close', (code, signal) => {
                if (!isOwnerAcquired) {
                    rejectAcquired(
                        new Error(
                            `Lock owner closed before acquisition: code=${String(code)} signal=${String(signal)} stderr=${ownerStderr}`,
                        ),
                    );
                }
                resolve();
            });
        });
        try {
            await acquired;
            await expect(withStateLock(path, () => Promise.resolve())).rejects.toThrow(
                'already locked by another writer',
            );
            process.kill(ownerPid, 'SIGKILL');
            await closed;

            await expect(withStateLock(path, () => Promise.resolve('recovered'))).resolves.toBe(
                'recovered',
            );
            await expect(access(join(directory, 'state.lock'))).rejects.toThrow();
        } finally {
            try {
                process.kill(ownerPid, 'SIGKILL');
            } catch {
                // The expected path already reaped the SIGKILLed owner.
            }
            await rm(directory, { force: true, recursive: true });
        }
    });
});

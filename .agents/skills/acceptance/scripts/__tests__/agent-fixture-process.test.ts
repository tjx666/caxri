import { spawn } from 'node:child_process';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
    observeAgentFixtureProcess,
    stopAgentFixtureProcess,
    waitForAgentFixtureReady,
} from '../agent-fixture-process';

function spawnNode(source: string) {
    return spawn(process.execPath, ['-e', source], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

describe('Acceptance Agent fixture process lifecycle', () => {
    it('observes a delayed ready marker without relying on a polling default', async () => {
        const process = observeAgentFixtureProcess(
            spawnNode(
                "setTimeout(() => process.stdout.write('fixture-ready'), 1100); setInterval(() => {}, 1000)",
            ),
        );
        try {
            const lifecycle = await waitForAgentFixtureReady(process, 'fixture-ready');
            expect(lifecycle).toMatchObject({
                spawnObserved: true,
                timedOut: false,
            });
            expect(lifecycle.firstByteElapsedMs).toBeTypeOf('number');
            expect(lifecycle.readyElapsedMs).toBeTypeOf('number');
        } finally {
            await stopAgentFixtureProcess(process);
        }
    });

    it('reports an early exit without exposing process output', async () => {
        const process = observeAgentFixtureProcess(spawnNode('process.exit(7)'));

        await expect(waitForAgentFixtureReady(process, 'fixture-ready')).rejects.toMatchObject({
            lifecycle: {
                exitCode: 7,
                signal: null,
                spawnObserved: true,
                timedOut: false,
            },
        });
    });

    it('reports a spawn error without exposing the executable path', async () => {
        const process = observeAgentFixtureProcess(
            spawn('/definitely-missing-caxri-agent-fixture', [], {
                stdio: ['ignore', 'pipe', 'pipe'],
            }),
        );

        await expect(waitForAgentFixtureReady(process, 'fixture-ready')).rejects.toMatchObject({
            lifecycle: {
                errorClass: 'Error',
                spawnObserved: false,
                timedOut: false,
            },
        });
    });

    it('reports a bounded deadline when a process never becomes ready', async () => {
        const process = observeAgentFixtureProcess(spawnNode('setInterval(() => {}, 1000)'));
        try {
            await expect(
                waitForAgentFixtureReady(process, 'fixture-ready', { deadlineMs: 50 }),
            ).rejects.toMatchObject({
                lifecycle: {
                    exitCode: null,
                    signal: null,
                    timedOut: true,
                },
            });
        } finally {
            await stopAgentFixtureProcess(process);
        }
    });

    it('force kills a process that does not exit during the TERM grace period', async () => {
        const process = observeAgentFixtureProcess(
            spawnNode(
                "process.on('SIGTERM', () => {}); process.stdout.write('fixture-ready'); setInterval(() => {}, 1000)",
            ),
        );
        try {
            await waitForAgentFixtureReady(process, 'fixture-ready');
            await expect(
                stopAgentFixtureProcess(process, {
                    forceKillDeadlineMs: 500,
                    termGraceMs: 25,
                }),
            ).resolves.toMatchObject({
                forceKillSent: true,
                signal: 'SIGKILL',
                termSent: true,
            });
        } finally {
            await stopAgentFixtureProcess(process);
        }
    });
});

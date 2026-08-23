import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import {
    createPiSpikeEnvironment,
    createPiSpikeExecutableSource,
    createPiSpikeExtensionSource,
    createPiSpikeLaunch,
    createPiSpikeSessionId,
    isValidPiSessionId,
    readPiSpikeState,
    selectPiSpikeLifecycleEvent,
    verifyPiSpikeExecutable,
} from '../pi-pty-feasibility-support';

describe('Pi PTY feasibility support', () => {
    it('builds one isolated structured launch around a Caxri-owned session id', () => {
        const root = '/tmp/caxri-pi-spike';
        const sessionId = createPiSpikeSessionId('123e4567-e89b-12d3-a456-426614174000');
        const launch = createPiSpikeLaunch({
            endpoint: 'http://127.0.0.1:43210/v1',
            eventsPath: join(root, 'lifecycle.events'),
            extensionPath: join(root, 'extension.ts'),
            piBin: join(root, 'pi'),
            root,
            sessionId,
        });

        expect(sessionId).toBe('caxri-123e4567-e89b-12d3-a456-426614174000');
        expect(launch).toEqual({
            executable: join(root, 'pi'),
            args: [
                '--offline',
                '--no-approve',
                '--no-extensions',
                '--extension',
                join(root, 'extension.ts'),
                '--no-skills',
                '--no-prompt-templates',
                '--no-themes',
                '--no-context-files',
                '--provider',
                'caxri-spike',
                '--model',
                'caxri-spike/deterministic',
                '--session-id',
                sessionId,
                '--session-dir',
                join(root, 'sessions'),
            ],
            cwd: join(root, 'project'),
            env: createPiSpikeEnvironment({
                endpoint: 'http://127.0.0.1:43210/v1',
                eventsPath: join(root, 'lifecycle.events'),
                root,
            }),
        });
        expect(launch.env).not.toHaveProperty('ANTHROPIC_API_KEY');
        expect(launch.env).not.toHaveProperty('OPENAI_API_KEY');

        const executableSource = createPiSpikeExecutableSource(launch, {
            invocationReceiptPath: join(root, 'invocations.events'),
        });
        expect(executableSource).toContain('incoming[0] === "--version"');
        expect(executableSource).toContain('incoming[0] !== "resume"');
        expect(executableSource).toContain('args[sessionIdIndex] = sessionId');
    });

    it.each([
        ['caxri-valid', true],
        ['caxri.valid_id-1', true],
        ['caxri/invalid', false],
        [' invalid', false],
        ['invalid ', false],
        ['invalid session', false],
        ['-invalid', false],
        ['invalid-', false],
    ])('matches Pi session id validation for %s', (value, expected) => {
        expect(isValidPiSessionId(value)).toBe(expected);
    });

    it('emits a lifecycle-only extension with no transcript or RPC access', () => {
        const source = createPiSpikeExtensionSource();

        expect(source).toContain('session_start');
        expect(source).toContain('session_shutdown');
        expect(source).toContain('ctx.sessionManager.getSessionId()');
        expect(source).not.toMatch(/jsonl|transcript|rpc|readFile|readdir|appendEntry/i);
    });

    it('requires a new lifecycle event before accepting resume evidence', () => {
        const first = { detail: 'new', kind: 'session_start', sessionId: 'caxri-1' };
        const second = { detail: 'startup', kind: 'session_start', sessionId: 'caxri-1' };
        const isMatchingStart = (event: typeof first) =>
            event.kind === 'session_start' && event.sessionId === 'caxri-1';

        expect(selectPiSpikeLifecycleEvent([first], isMatchingStart, 2)).toBeUndefined();
        expect(selectPiSpikeLifecycleEvent([first, second], isMatchingStart, 2)).toBe(second);
    });

    it('returns undefined when Pi has no official metadata index', async () => {
        await expect(readPiSpikeState()).resolves.toBeUndefined();
    });

    it('rejects an official executable candidate outside a Caxri temporary acquisition root', async () => {
        const packagePath = join(process.cwd(), 'package.json');
        const verification = verifyPiSpikeExecutable(packagePath);

        await expect(verification).rejects.toThrow(
            'must resolve inside a Caxri-owned operating-system temporary directory',
        );
    });

    it('rejects spike-owned files outside the temporary root', () => {
        expect(() =>
            createPiSpikeLaunch({
                endpoint: 'http://127.0.0.1:43210/v1',
                eventsPath: '/tmp/outside.events',
                extensionPath: '/tmp/caxri-pi-spike/extension.ts',
                piBin: '/tmp/pi',
                root: '/tmp/caxri-pi-spike',
                sessionId: 'caxri-1',
            }),
        ).toThrow('events path must stay inside the temporary root');
    });

    it('rejects a non-loopback model endpoint', () => {
        expect(() =>
            createPiSpikeLaunch({
                endpoint: 'https://models.example.com/v1',
                eventsPath: '/tmp/caxri-pi-spike/lifecycle.events',
                extensionPath: '/tmp/caxri-pi-spike/extension.ts',
                piBin: '/tmp/pi',
                root: '/tmp/caxri-pi-spike',
                sessionId: 'caxri-1',
            }),
        ).toThrow('Pi spike endpoint must use isolated loopback HTTP');
    });

    it('rejects an invocation receipt outside the temporary root', () => {
        const root = '/tmp/caxri-pi-spike';
        const launch = createPiSpikeLaunch({
            endpoint: 'http://127.0.0.1:43210/v1',
            eventsPath: join(root, 'lifecycle.events'),
            extensionPath: join(root, 'extension.ts'),
            piBin: join(root, 'pi'),
            root,
            sessionId: 'caxri-1',
        });

        expect(() =>
            createPiSpikeExecutableSource(launch, {
                invocationReceiptPath: '/tmp/outside.events',
            }),
        ).toThrow('Pi invocation receipt path must stay inside the temporary root');
    });
});

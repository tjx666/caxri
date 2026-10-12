import { execFile, spawn } from 'node:child_process';
import { access, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { RemoteAskpassRequest } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AskpassHandler } from '../askpass';
import { AskpassBridge, classifyAskpassPrompt } from '../askpass';
import { makeShortTemporaryDirectory } from './support/remote-fixtures';

describe('askpass', () => {
    let root: string;
    let bridge: AskpassBridge | undefined;

    beforeEach(async () => {
        root = await makeShortTemporaryDirectory('ask');
    });

    afterEach(async () => {
        await bridge?.close();
        bridge = undefined;
        await rm(root, { force: true, recursive: true });
    });

    function runHelper(
        helperPath: string,
        prompt: string,
        environment: NodeJS.ProcessEnv = {},
    ): Promise<{ code: number; stdout: string }> {
        return new Promise((resolve) => {
            execFile(
                helperPath,
                [prompt],
                { env: { PATH: process.env.PATH, ...environment } },
                (error, stdout) => {
                    resolve({ code: error ? Number(error.code ?? 1) : 0, stdout });
                },
            );
        });
    }

    async function createBridge(handler: AskpassHandler): Promise<AskpassBridge> {
        bridge = await AskpassBridge.create({
            directory: join(root, 'ssh'),
            electronExecutable: process.execPath,
            handler,
        });
        return bridge;
    }

    describe('classifyAskpassPrompt', () => {
        it.each([
            [
                "The authenticity of host 'lab (192.0.2.1)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?",
                'confirm',
            ],
            ["dev@lab's password: ", 'secret'],
            ["Enter passphrase for key '/home/dev/.ssh/id_ed25519': ", 'secret'],
            ['Verification code: ', 'secret'],
            ['Enter PIN for ECDSA-SK key: ', 'secret'],
            ['Please type your favourite color: ', 'text'],
        ])('classifies %j as %s', (prompt, kind) => {
            expect(classifyAskpassPrompt(prompt)).toBe(kind);
        });
    });

    describe('AskpassBridge', () => {
        it('forwards the prompt and prints the answer', async () => {
            const requests: RemoteAskpassRequest[] = [];
            const created = await createBridge((request) => {
                requests.push(request);
                return Promise.resolve('s3cret pass');
            });
            const environment = created.environment();
            expect(environment).toMatchObject({ DISPLAY: 'caxri', SSH_ASKPASS_REQUIRE: 'force' });
            expect((await stat(created.helperPath)).mode & 0o777).toBe(0o700);
            expect((await stat(created.directory)).mode & 0o777).toBe(0o700);

            const result = await runHelper(created.helperPath, "dev@lab's password: \u{1B}[31m");
            expect(result).toEqual({ code: 0, stdout: 's3cret pass\n' });
            expect(requests).toHaveLength(1);
            expect(requests[0]).toMatchObject({
                kind: 'secret',
                prompt: "dev@lab's password: [31m",
            });
            expect(requests[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
        });

        it('exits non-zero when the user cancels or the handler throws', async () => {
            let call = 0;
            const created = await createBridge(() => {
                call += 1;
                return call === 1 ? Promise.resolve(null) : Promise.reject(new Error('boom'));
            });
            expect((await runHelper(created.helperPath, 'Password: ')).code).toBe(1);
            expect((await runHelper(created.helperPath, 'Password: ')).code).toBe(1);
        });

        it('refuses a helper without the token', async () => {
            let isCalled = false;
            const created = await createBridge(() => {
                isCalled = true;
                return Promise.resolve('leaked');
            });
            const wrapper = await readFile(created.helperPath, 'utf8');
            const socket = /CAXRI_ASKPASS_SOCKET='([^']+)'/u.exec(wrapper)?.[1];
            expect(socket).toBeDefined();
            const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
                execFile(
                    process.execPath,
                    [join(created.directory, 'askpass.cjs'), 'Password: '],
                    {
                        env: {
                            CAXRI_ASKPASS_SOCKET: socket,
                            CAXRI_ASKPASS_TOKEN: 'ab'.repeat(32),
                        },
                    },
                    (error, stdout) => resolve({ code: error ? Number(error.code) : 0, stdout }),
                );
            });
            expect(result).toEqual({ code: 1, stdout: '' });
            expect(isCalled).toBe(false);
        });

        it('aborts the pending prompt when the helper dies', async () => {
            const { promise: aborted, resolve: resolveAborted } = Promise.withResolvers<void>();
            const { promise: started, resolve: resolveStarted } = Promise.withResolvers<void>();
            const created = await createBridge(
                (_request, signal) =>
                    new Promise((resolve) => {
                        resolveStarted();
                        signal.addEventListener('abort', () => {
                            resolveAborted();
                            resolve(null);
                        });
                    }),
            );
            const helper = spawn(created.helperPath, ['Password: '], { stdio: 'ignore' });
            await started;
            helper.kill('SIGKILL');
            await aborted;
        });

        it('answers pending prompts with a refusal and removes its directory on close', async () => {
            const created = await createBridge(
                (_request, signal) =>
                    new Promise((resolve) => {
                        signal.addEventListener('abort', () => resolve('too late'));
                    }),
            );
            const pending = runHelper(created.helperPath, 'Password: ');
            // Give the helper time to connect before closing.
            await new Promise((resolve) => setTimeout(resolve, 300));
            await created.close();
            bridge = undefined;
            expect((await pending).code).toBe(1);
            await expect(access(created.directory)).rejects.toThrow();
        });
    });
});

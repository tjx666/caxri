import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { stageAgentHookBridge } from '../bridge';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingCleanup = [...temporaryDirectories];
    temporaryDirectories.length = 0;
    await Promise.all(pendingCleanup.map((path) => rm(path, { recursive: true, force: true })));
});

async function sharedDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-hook-bridge-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('stageAgentHookBridge', () => {
    it('stages an executable bridge wrapper, its script, and a manifest on first run', async () => {
        const sharedPath = await sharedDirectory();

        const bridgePath = await stageAgentHookBridge(sharedPath);

        expect(bridgePath).toBe(join(sharedPath, 'bin', 'caxri-agent-hook-bridge'));
        const [wrapperSource, bridgeScript, manifestSource, wrapperStats] = await Promise.all([
            readFile(bridgePath, 'utf8'),
            readFile(join(sharedPath, 'bin', 'bridge.cjs'), 'utf8'),
            readFile(join(sharedPath, 'bin', 'manifest.json'), 'utf8'),
            stat(bridgePath),
        ]);
        expect(wrapperSource).toContain('#!/bin/sh');
        expect(bridgeScript).toContain("require('node:net')");
        expect(JSON.parse(manifestSource)).toEqual({ bridgeVersion: 7 });
        expect(wrapperStats.mode & 0o777).toBe(0o700);
    });

    it('is idempotent when re-staged with the same version', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const bridgeScriptPath = join(sharedPath, 'bin', 'bridge.cjs');
        const manifestPath = join(sharedPath, 'bin', 'manifest.json');
        const [wrapperBefore, scriptBefore, manifestBefore] = await Promise.all([
            stat(bridgePath),
            stat(bridgeScriptPath),
            stat(manifestPath),
        ]);

        const restagedPath = await stageAgentHookBridge(sharedPath);

        expect(restagedPath).toBe(bridgePath);
        const [wrapperAfter, scriptAfter, manifestAfter] = await Promise.all([
            stat(bridgePath),
            stat(bridgeScriptPath),
            stat(manifestPath),
        ]);
        // An unchanged staged bridge is never rewritten, so the inode identity of every file survives.
        expect(wrapperAfter.ino).toBe(wrapperBefore.ino);
        expect(scriptAfter.ino).toBe(scriptBefore.ino);
        expect(manifestAfter.ino).toBe(manifestBefore.ino);
    });

    it('never downgrades a bridge already staged by a newer Caxri build', async () => {
        const sharedPath = await sharedDirectory();
        const binDirectory = join(sharedPath, 'bin');
        await mkdir(binDirectory, { recursive: true });
        const bridgePath = join(binDirectory, 'caxri-agent-hook-bridge');
        const futureWrapper = '#!/bin/sh\necho "from-the-future"\n';
        const futureScript = "'use strict';\nconsole.log('from-the-future');\n";
        await Promise.all([
            writeFile(bridgePath, futureWrapper, { mode: 0o700 }),
            writeFile(join(binDirectory, 'bridge.cjs'), futureScript, { mode: 0o600 }),
            writeFile(
                join(binDirectory, 'manifest.json'),
                `${JSON.stringify({ bridgeVersion: 999 }, null, 2)}\n`,
                'utf8',
            ),
        ]);

        const returnedPath = await stageAgentHookBridge(sharedPath);

        expect(returnedPath).toBe(bridgePath);
        const [wrapperSource, scriptSource, manifestSource] = await Promise.all([
            readFile(bridgePath, 'utf8'),
            readFile(join(binDirectory, 'bridge.cjs'), 'utf8'),
            readFile(join(binDirectory, 'manifest.json'), 'utf8'),
        ]);
        expect(wrapperSource).toBe(futureWrapper);
        expect(scriptSource).toBe(futureScript);
        expect(JSON.parse(manifestSource)).toEqual({ bridgeVersion: 999 });
    });

    it('repairs staging when the manifest is corrupt or unparsable', async () => {
        const sharedPath = await sharedDirectory();
        const binDirectory = join(sharedPath, 'bin');
        await mkdir(binDirectory, { recursive: true });
        await writeFile(join(binDirectory, 'manifest.json'), '{ not valid json', 'utf8');

        const bridgePath = await stageAgentHookBridge(sharedPath);

        const [manifestSource, wrapperSource, scriptSource] = await Promise.all([
            readFile(join(binDirectory, 'manifest.json'), 'utf8'),
            readFile(bridgePath, 'utf8'),
            readFile(join(binDirectory, 'bridge.cjs'), 'utf8'),
        ]);
        expect(JSON.parse(manifestSource)).toEqual({ bridgeVersion: 7 });
        expect(wrapperSource).toContain('#!/bin/sh');
        expect(scriptSource).toContain("require('node:net')");
    });

    it('stays silent outside a Caxri-launched Terminal', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { PATH: process.env.PATH },
        });

        expect(result.stderr).toBe('');
    });

    it('stays silent when inherited Caxri context no longer has a launch runtime', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { CAXRI_HOOK_TOKEN: 'launch-context', PATH: process.env.PATH },
        });

        expect(result.stderr).toBe('');
    });

    it('stays silent when inherited Caxri context points to a retired socket', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(
            bridgePath,
            ['--provider', 'codex', '--phase', 'sessionIdentified', '--schema', '5'],
            {
                env: {
                    CAXRI_HOOK_LAUNCH_ID: 'retired-launch',
                    CAXRI_HOOK_RUNTIME: process.execPath,
                    CAXRI_HOOK_SOCKET: join(sharedPath, 'retired.sock'),
                    CAXRI_HOOK_TERMINAL_ID: 'retired-terminal',
                    CAXRI_HOOK_TOKEN: 'retired-token',
                    PATH: process.env.PATH,
                },
            },
        );

        expect(result.stderr).toBe('');
    });

    it('stays silent when partial inherited context has no live Caxri socket', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { CAXRI_HOOK_RUNTIME: process.execPath, PATH: process.env.PATH },
        });

        expect(result.stderr).toBe('');
    });

    it('reports incomplete launch context when a live Caxri socket exists', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const socketPath = join(sharedPath, 'live.sock');
        const server = createServer();
        server.listen(socketPath);
        await once(server, 'listening');

        try {
            const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
                env: {
                    CAXRI_HOOK_LAUNCH_ID: 'launch-without-token',
                    CAXRI_HOOK_RUNTIME: process.execPath,
                    CAXRI_HOOK_SOCKET: socketPath,
                    CAXRI_HOOK_TERMINAL_ID: 'terminal-1',
                    PATH: process.env.PATH,
                },
            });

            expect(result.stderr).toBe('caxri-hook: launch_context_unavailable\n');
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it('scrubs arbitrary runtime stderr behind a fixed bridge failure diagnostic', async () => {
        const sharedPath = await sharedDirectory();
        const bridgePath = await stageAgentHookBridge(sharedPath);
        const failingRuntime = join(sharedPath, 'failing-runtime');
        await writeFile(
            failingRuntime,
            "#!/bin/sh\nprintf 'private stdout detail'\nprintf 'private runtime detail' >&2\nexit 99\n",
            { mode: 0o700 },
        );

        const result = await execFileAsync(bridgePath, ['--provider', 'codex'], {
            env: { CAXRI_HOOK_RUNTIME: failingRuntime, PATH: process.env.PATH },
        });

        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('caxri-hook: bridge_runtime_failed\n');
        expect(result.stderr).not.toContain('private runtime detail');
    });
});

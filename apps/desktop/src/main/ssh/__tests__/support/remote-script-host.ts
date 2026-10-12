import type { Buffer } from 'node:buffer';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { expect } from 'vitest';

import type { RemoteScript } from '../../remote-scripts';
import { installAppScript, parseRemoteResult, uploadRuntimeScript } from '../../remote-scripts';
import type { LayerFixture } from './remote-fixtures';
import {
    hostEnvironment,
    killRemoteServer,
    linuxShims,
    makeShortTemporaryDirectory,
    runLocalScript,
    writeShims,
} from './remote-fixtures';

export interface RemoteScriptRun {
    code: number | null;
    result: Map<string, string> | undefined;
    stderr: string;
}

/**
 * A disposable stand-in SSH Host for the remote script tests: a temporary `$HOME`, a shim directory placed first on
 * `PATH` that makes the local machine look like a Linux host, and helpers that run scripts with the local `/bin/sh`.
 */
export class RemoteScriptHost {
    static async create(): Promise<RemoteScriptHost> {
        const root = await makeShortTemporaryDirectory('scr');
        const home = join(root, 'home');
        const shims = join(root, 'shims');
        await mkdir(home);
        await writeShims(shims, linuxShims());
        return new RemoteScriptHost(root, home, shims);
    }

    /**
     * Environment every script runs with; a test may replace it to change `PATH`.
     */
    environment: NodeJS.ProcessEnv;

    private constructor(
        readonly root: string,
        readonly home: string,
        readonly shims: string,
    ) {
        this.environment = hostEnvironment(home, shims);
    }

    async dispose(): Promise<void> {
        await killRemoteServer(this.home);
        await rm(this.root, { force: true, recursive: true });
    }

    async run(script: RemoteScript, stdin?: Buffer): Promise<RemoteScriptRun> {
        const output = await runLocalScript(script.script, this.environment, stdin);
        return {
            code: output.code,
            result: parseRemoteResult(output.stdout, script.marker),
            stderr: output.stderr,
        };
    }

    serverRoot(): string {
        return join(this.home, '.caxri-server');
    }

    remotePath(...segments: string[]): string {
        return join(this.serverRoot(), ...segments);
    }

    async listRemote(...segments: string[]): Promise<string[]> {
        return (await readdir(this.remotePath(...segments))).toSorted((left, right) =>
            left.localeCompare(right),
        );
    }

    async installRuntime(fixture: LayerFixture): Promise<void> {
        const uploaded = await this.run(
            uploadRuntimeScript({ runtimeSha256: fixture.descriptor.runtime.sha256 }),
            gzipSync(fixture.runtimeContent),
        );
        expect(uploaded.result?.get('status')).toBe('installed');
    }

    async installBuild(fixture: LayerFixture, layers: string): Promise<void> {
        await this.installRuntime(fixture);
        const installed = await this.run(
            installAppScript({
                appSha256: fixture.descriptor.app.sha256,
                buildId: fixture.descriptor.buildId,
                runtimePath: fixture.descriptor.runtime.path,
                runtimeSha256: fixture.descriptor.runtime.sha256,
            }),
            await readFile(join(layers, 'linux-x64', 'app.tar.gz')),
        );
        expect(installed.result?.get('status')).toBe('installed');
    }
}

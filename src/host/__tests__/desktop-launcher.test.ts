import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createDesktopLauncher } from '../desktop-launcher';

class FakeDesktopProcess extends EventEmitter {
    unref = vi.fn();
}

describe('Host Desktop launcher', () => {
    it('uses fixed structured argv without inheriting Electron Node mode or unrelated secrets', async () => {
        const child = new FakeDesktopProcess();
        const spawnProcess = vi.fn(() => child as never);
        const launch = createDesktopLauncher({
            launch: {
                executable: '/Applications/Caxri.app/Contents/MacOS/Caxri',
                args: ['--profile', 'isolated'],
                cwd: '/Applications/Caxri.app/Contents/MacOS',
            },
            sourceEnvironment: {
                ELECTRON_RUN_AS_NODE: '1',
                HOME: '/Users/test',
                SECRET_TOKEN: 'must-not-cross',
            },
            spawnProcess,
            userDataPath: '/profiles/isolated',
        });
        const launched = launch();
        child.emit('spawn');
        await launched;

        expect(spawnProcess).toHaveBeenCalledWith(
            '/Applications/Caxri.app/Contents/MacOS/Caxri',
            ['--profile', 'isolated'],
            expect.objectContaining({
                cwd: '/Applications/Caxri.app/Contents/MacOS',
                detached: true,
                stdio: 'ignore',
            }),
        );
        const invocation = spawnProcess.mock.calls[0] as unknown as [
            string,
            string[],
            { env: NodeJS.ProcessEnv },
        ];
        const environment = invocation[2].env;
        expect(environment).toMatchObject({
            HOME: '/Users/test',
            CAXRI_USER_DATA_DIR: '/profiles/isolated',
        });
        expect(environment).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
        expect(environment).not.toHaveProperty('SECRET_TOKEN');
        expect(child.unref).toHaveBeenCalledOnce();
    });
});

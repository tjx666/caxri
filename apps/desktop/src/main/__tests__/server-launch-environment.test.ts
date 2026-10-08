import { describe, expect, it } from 'vitest';

import { buildServerLaunchEnvironment } from '../server-launch-environment';

const baseOptions = {
    cliPath: '/fake/cli',
    desktopLaunch: { executable: '/fake/desktop', args: [], cwd: '/fake' },
};

describe('buildServerLaunchEnvironment', () => {
    it('always forwards the Desktop launch identity and CLI path', () => {
        const environment = buildServerLaunchEnvironment(baseOptions, {});

        expect(environment).toMatchObject({ CAXRI_CLI_PATH: '/fake/cli' });
        expect(environment.CAXRI_DESKTOP_LAUNCH).toBeDefined();
    });

    it('forwards the compile cache directory only when Main enabled one', () => {
        expect(buildServerLaunchEnvironment(baseOptions, {})).not.toHaveProperty(
            'CAXRI_COMPILE_CACHE_DIR',
        );
        expect(
            buildServerLaunchEnvironment(baseOptions, {
                CAXRI_COMPILE_CACHE_DIR: '/fake/compile-cache',
            }),
        ).toMatchObject({ CAXRI_COMPILE_CACHE_DIR: '/fake/compile-cache' });
    });

    it('forwards an internal idle-exit threshold override unconditionally, not only under E2E', () => {
        const environment = buildServerLaunchEnvironment(baseOptions, {
            CAXRI_SERVER_IDLE_EXIT_MS: '5000',
        });

        expect(environment).toMatchObject({ CAXRI_SERVER_IDLE_EXIT_MS: '5000' });
    });

    it('omits the idle-exit override when unset', () => {
        const environment = buildServerLaunchEnvironment(baseOptions, {});

        expect(environment).not.toHaveProperty('CAXRI_SERVER_IDLE_EXIT_MS');
    });

    it('forwards the synthetic mobile host label only alongside CAXRI_E2E=1', () => {
        const underE2E = buildServerLaunchEnvironment(baseOptions, {
            CAXRI_E2E: '1',
            CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host',
        });
        const outsideE2E = buildServerLaunchEnvironment(baseOptions, {
            CAXRI_E2E: '0',
            CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host',
        });

        expect(underE2E).toMatchObject({ CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME: 'Caxri Test Host' });
        expect(outsideE2E).not.toHaveProperty('CAXRI_MOBILE_TEST_HOST_DISPLAY_NAME');
    });

    it('forwards the Terminal resource override file to Server Core, which gates it on CAXRI_E2E', () => {
        expect(buildServerLaunchEnvironment(baseOptions, {})).not.toHaveProperty(
            'CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE',
        );
        expect(
            buildServerLaunchEnvironment(baseOptions, {
                CAXRI_E2E: '1',
                CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE: '/tmp/resource-override.json',
            }),
        ).toMatchObject({
            CAXRI_E2E_TERMINAL_RESOURCE_OVERRIDE_FILE: '/tmp/resource-override.json',
        });
    });

    it('forwards a local mobile update directory unconditionally', () => {
        const environment = buildServerLaunchEnvironment(baseOptions, {
            CAXRI_MOBILE_UPDATE_DIRECTORY: '/tmp/mobile-update',
        });

        expect(environment).toMatchObject({ CAXRI_MOBILE_UPDATE_DIRECTORY: '/tmp/mobile-update' });
    });

    it('forwards the optional agent hooks path only when configured', () => {
        const withHooks = buildServerLaunchEnvironment(
            { ...baseOptions, agentHooksPath: '/fake/hooks' },
            {},
        );
        const withoutHooks = buildServerLaunchEnvironment(baseOptions, {});

        expect(withHooks).toMatchObject({ CAXRI_AGENT_HOOKS_PATH: '/fake/hooks' });
        expect(withoutHooks).not.toHaveProperty('CAXRI_AGENT_HOOKS_PATH');
    });
});

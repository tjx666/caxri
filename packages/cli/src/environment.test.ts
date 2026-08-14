import { describe, expect, it } from 'vitest';

import {
    resolveAgentEndpointCredential,
    resolveCliHostLaunch,
    resolveCliProfile,
} from './environment';

describe('CLI profile resolution', () => {
    it('requires one complete Agent Endpoint generation credential', () => {
        expect(
            resolveAgentEndpointCredential({
                CAXRI_AGENT_ENDPOINT_HOST_ID: 'a'.repeat(32),
                CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1',
                CAXRI_AGENT_ENDPOINT_GENERATION: '2',
                CAXRI_AGENT_ENDPOINT_TOKEN: 'ab'.repeat(32),
            }),
        ).toEqual({
            kind: 'agent',
            hostId: 'a'.repeat(32),
            endpointId: 'endpoint-1',
            generation: 2,
            token: 'ab'.repeat(32),
        });
        expect(() =>
            resolveAgentEndpointCredential({ CAXRI_AGENT_ENDPOINT_ID: 'endpoint-1' }),
        ).toThrow('incomplete or invalid');
    });

    it('uses the explicit selector before the shared profile environment', () => {
        expect(
            resolveCliProfile({
                environment: { CAXRI_USER_DATA_DIR: '/profiles/environment' },
                explicit: '/profiles/argument',
                home: '/Users/test',
                platform: 'darwin',
            }),
        ).toEqual({ path: '/profiles/argument', source: 'argument' });
    });

    it('derives non-macOS defaults only from the injected environment', () => {
        expect(
            resolveCliProfile({
                environment: { XDG_CONFIG_HOME: '/xdg/config' },
                home: '/home/test',
                platform: 'linux',
            }),
        ).toEqual({ path: '/xdg/config/Caxri', source: 'default' });
    });

    it('rejects relative selectors instead of resolving them against the shell directory', () => {
        expect(() =>
            resolveCliProfile({
                environment: { CAXRI_USER_DATA_DIR: 'relative/profile' },
                home: '/Users/test',
                platform: 'darwin',
            }),
        ).toThrow('must be an absolute path');
    });

    it('accepts only a complete app-managed Host launch pair and bounded environment', () => {
        expect(
            resolveCliHostLaunch({
                CAXRI_HOST_EXECUTABLE: '/Applications/Caxri.app/Contents/MacOS/Caxri',
                CAXRI_HOST_ENTRY_PATH:
                    '/Applications/Caxri.app/Contents/Resources/app.asar/out/main/host.js',
                CAXRI_CLI_PATH: '/Applications/Caxri.app/Contents/Resources/cli/caxri.cjs',
                SECRET_SENTINEL: 'must-not-propagate',
            }),
        ).toEqual({
            executable: '/Applications/Caxri.app/Contents/MacOS/Caxri',
            entryPath: '/Applications/Caxri.app/Contents/Resources/app.asar/out/main/host.js',
            environment: {
                CAXRI_CLI_PATH: '/Applications/Caxri.app/Contents/Resources/cli/caxri.cjs',
            },
        });
        expect(() =>
            resolveCliHostLaunch({ CAXRI_HOST_EXECUTABLE: '/Applications/Caxri' }),
        ).toThrow('incomplete');
        expect(() =>
            resolveCliHostLaunch({
                CAXRI_HOST_EXECUTABLE: 'relative/Caxri',
                CAXRI_HOST_ENTRY_PATH: '/app/host.js',
            }),
        ).toThrow('must be absolute');
    });
});

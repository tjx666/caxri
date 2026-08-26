import { describe, expect, it } from 'vitest';

import {
    resolveAgentEndpointCredential,
    resolveCliProfile,
    resolvePackagedServerLaunch,
} from '../environment';

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

    it('derives Server launch only from the executing packaged application layout', () => {
        const resourcesPath = '/Applications/Caxri.app/Contents/Resources';
        expect(
            resolvePackagedServerLaunch({
                executable: '/Applications/Caxri.app/Contents/MacOS/Caxri',
                resourcesPath,
                runAsNode: '1',
                scriptPath: `${resourcesPath}/cli/caxri.cjs`,
            }),
        ).toEqual({
            artifactRoot: '/Applications/Caxri.app/Contents/Resources/server',
        });
        expect(
            resolvePackagedServerLaunch({
                executable: '/bin/sh',
                resourcesPath,
                runAsNode: '1',
                scriptPath: '/tmp/attacker.cjs',
            }),
        ).toBeUndefined();
        expect(
            resolvePackagedServerLaunch({
                executable: '/Applications/Caxri.app/Contents/MacOS/Caxri',
                resourcesPath,
                runAsNode: '1',
                scriptPath: '/tmp/forged-cli.cjs',
            }),
        ).toBeUndefined();
    });
});

import { describe, expect, it } from 'vitest';

import {
    detectAutomation,
    resolveAgentEndpointCredential,
    resolveCliProfile,
    resolveDelegationClientCredential,
    resolvePackagedServerLaunch,
} from '../environment';

describe('CLI profile resolution', () => {
    it('requires a complete external delegation credential and an explicit profile', () => {
        const environment = {
            CAXRI_DELEGATION_CLIENT_ID: '2db7c655-e217-49db-91fc-dd48286e6601',
            CAXRI_DELEGATION_GENERATION: '1',
            CAXRI_DELEGATION_TOKEN: 'ab'.repeat(32),
            CAXRI_USER_DATA_DIR: '/synthetic/profile',
        };
        expect(resolveDelegationClientCredential({})).toBeUndefined();
        expect(resolveDelegationClientCredential(environment)).toMatchObject({
            kind: 'delegation-client',
            generation: 1,
        });
        expect(() =>
            resolveDelegationClientCredential({
                ...environment,
                CAXRI_DELEGATION_TOKEN: undefined,
            }),
        ).toThrow();
        expect(() =>
            resolveDelegationClientCredential({ ...environment, CAXRI_USER_DATA_DIR: undefined }),
        ).toThrow();
    });
    it('treats external Grok invocations as automation without granting owner startup', () => {
        expect(detectAutomation({ GROK_SESSION_ID: 'synthetic-native-session' })).toBe('agent');
        expect(detectAutomation({ GROK_SESSION_ID: '' })).toBe('human');
        expect(detectAutomation({ GROK_SESSION_ID: 'synthetic-native-session', CI: '1' })).toBe(
            'ci',
        );
    });
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
                home: '/Users/test',
                platform: 'darwin',
                resourcesPath,
                runAsNode: '1',
                scriptPath: `${resourcesPath}/cli/caxri.cjs`,
            }),
        ).toEqual({
            artifactRoot: '/Applications/Caxri.app/Contents/Resources/server',
            environment: {
                CAXRI_CLI_PATH: '/Applications/Caxri.app/Contents/Resources/cli/caxri.cjs',
                CAXRI_AGENT_HOOKS_PATH: '/Users/test/Library/Application Support/caxri/agent-hooks',
            },
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

import { describe, expect, it, vi } from 'vitest';

import { agentCommandEnvironment } from '../rename';

vi.mock('../../executables', () => ({
    serverProcessEnvironment: (variables: NodeJS.ProcessEnv = {}) =>
        Promise.resolve({ ...variables, PATH: '/login/bin' }),
}));

describe('agentCommandEnvironment', () => {
    it('launches a provider CLI on the login PATH, not the PATH the Server was started with', async () => {
        const environment = await agentCommandEnvironment({
            homeDirectory: '/agent-home',
            variables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', CODEX_HOME: '/agent-home/.codex' },
        });

        expect(environment).toMatchObject({
            CODEX_HOME: '/agent-home/.codex',
            HOME: '/agent-home',
            PATH: '/login/bin',
        });
    });
});

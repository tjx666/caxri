import { describe, expect, it } from 'vitest';

import { removeHostAgentEnvironment } from '../../vitest.global-setup';

describe('Vitest global setup', () => {
    it('drops the variables a Caxri Agent Terminal injects and keeps the rest', () => {
        const environment: NodeJS.ProcessEnv = {
            CAXRI_CLI: '/profile/bin/caxri',
            CAXRI_CLI_PATH: '/profile/cli/caxri.cjs',
            CAXRI_MANAGED_AGENT: '1',
            CAXRI_AGENT_ENDPOINT_TOKEN: 'token',
            CAXRI_USER_DATA_DIR: '/profile',
            CAXRI_VITEST_MAX_WORKERS: '2',
            PATH: '/usr/bin',
        };

        removeHostAgentEnvironment(environment);

        expect(environment).toEqual({ CAXRI_VITEST_MAX_WORKERS: '2', PATH: '/usr/bin' });
    });
});

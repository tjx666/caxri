import { describe, expect, it } from 'vitest';

import { terminalEnvironment } from '../terminal';

describe('terminalEnvironment', () => {
    it('passes required shell context without leaking app or credential variables', () => {
        const environment = terminalEnvironment({
            CAXRI_USER_DATA_PATH: '/private/data',
            HOME: '/Users/example',
            HTTPS_PROXY: 'http://proxy.example',
            NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
            OPENAI_API_KEY: 'secret',
            PATH: '/usr/bin',
            SHELL: '/bin/zsh',
            SSH_AUTH_SOCK: '/private/ssh-agent',
            npm_config_token: 'secret',
        });

        expect(environment).toMatchObject({
            COLORTERM: 'truecolor',
            HOME: '/Users/example',
            HTTPS_PROXY: 'http://proxy.example',
            NODE_EXTRA_CA_CERTS: '/etc/company-ca.pem',
            PATH: '/usr/bin',
            SHELL: '/bin/zsh',
            SSH_AUTH_SOCK: '/private/ssh-agent',
            TERM: 'xterm-256color',
        });
        expect(environment).not.toHaveProperty('CAXRI_USER_DATA_PATH');
        expect(environment).not.toHaveProperty('OPENAI_API_KEY');
        expect(environment).not.toHaveProperty('npm_config_token');
    });
});

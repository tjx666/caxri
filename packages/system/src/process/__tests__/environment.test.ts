import { describe, expect, it } from 'vitest';

import { safeProcessEnvironment } from '../environment';

describe('safeProcessEnvironment', () => {
    it('keeps runtime discovery paths without inheriting unrelated credentials', () => {
        expect(
            safeProcessEnvironment({
                CODEX_HOME: '/tmp/codex',
                CODEX_SQLITE_HOME: '/tmp/codex-sqlite',
                CLAUDE_CONFIG_DIR: '/tmp/claude',
                CAXRI_RUNNER_OWNER: 'caxri-42-1-e2e',
                DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
                GITHUB_TOKEN: 'secret',
                PATH: '/usr/bin',
            }),
        ).toEqual({
            CODEX_HOME: '/tmp/codex',
            CODEX_SQLITE_HOME: '/tmp/codex-sqlite',
            CLAUDE_CONFIG_DIR: '/tmp/claude',
            DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
            PATH: '/usr/bin',
        });
    });

    it('keeps proxy and CA trust context in both spellings without inheriting API keys', () => {
        const networkContext = {
            HTTPS_PROXY: 'https://proxy.example.test:3128',
            https_proxy: 'https://proxy.example.test:3128',
            NO_PROXY: 'localhost',
            NODE_EXTRA_CA_CERTS: '/fixture/ca/extra.pem',
            SSL_CERT_FILE: '/fixture/ca/bundle.pem',
            SSL_CERT_DIR: '/fixture/ca',
            ZDOTDIR: '/fixture/zdotdir',
        };
        expect(
            safeProcessEnvironment({ ...networkContext, OPENAI_API_KEY: 'excluded-fixture' }),
        ).toEqual(networkContext);
    });
});

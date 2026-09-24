import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';

const AGENT_ENVIRONMENT_KEYS: Record<AgentProvider, readonly string[]> = {
    grok: ['GROK_HOME'],
    claude: ['CLAUDE_CONFIG_DIR'],
    codex: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
};

const INHERITED_ENVIRONMENT_KEYS = [
    /**
     * Keeps detached descendants attributable to their owning CI run during cleanup.
     */
    'CAXRI_RUNNER_OWNER',
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    /**
     * Keeps the selected Xcode toolchain available to Git and other launched tools.
     */
    'DEVELOPER_DIR',
    'SHELL',
    'ZDOTDIR',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'TMPDIR',
    'SSH_AUTH_SOCK',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    ...agentProviderIds.flatMap((provider) => AGENT_ENVIRONMENT_KEYS[provider]),
] as const;

/**
 * Retains explicit launch context without copying unrelated application credentials.
 */
export function safeProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENVIRONMENT_KEYS) {
        if (source[key] !== undefined) environment[key] = source[key];
    }
    return environment;
}

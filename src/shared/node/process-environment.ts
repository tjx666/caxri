import process from 'node:process';

const INHERITED_ENVIRONMENT_KEYS = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
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
    'CODEX_HOME',
    'CODEX_SQLITE_HOME',
    'CLAUDE_CONFIG_DIR',
] as const;

/**
Retains explicit launch context without copying unrelated application credentials.
 */
export function safeProcessEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENVIRONMENT_KEYS) {
        if (source[key] !== undefined) environment[key] = source[key];
    }
    return environment;
}

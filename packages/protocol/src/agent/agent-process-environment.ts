import type { AgentProvider } from './agents.js';
import { agentProviderIds } from './agents.js';

/**
 * Environment variables that relocate each Agent provider's local state (configuration, sessions, and state indexes).
 * Launchers forward them so a launched Agent reads the state the operator's shell would, and test harnesses isolate
 * exactly these keys so a run never reaches a developer's real Agent state. The exhaustive record makes a new provider
 * fail typecheck until its state overrides are named here.
 */
export const AGENT_STATE_ENVIRONMENT_KEYS: Readonly<Record<AgentProvider, readonly string[]>> = {
    claude: ['CLAUDE_CONFIG_DIR'],
    codex: ['CODEX_HOME', 'CODEX_SQLITE_HOME'],
    grok: ['GROK_HOME'],
    /**
     * Antigravity keeps its state under `$HOME/.gemini` with no variable to relocate it, so isolation needs `HOME`.
     */
    antigravity: [],
};

/**
 * Non-credential launch context every Caxri process hands down: Desktop Main and the CLI to Server Core, then Server
 * Core to its Hosts, Agent providers, Git, and Terminals. Keeping one list means a key the operator's shell exported (a
 * proxy, a TLS-inspecting CA bundle, the selected Xcode toolchain) reaches the leaf process instead of being silently
 * dropped at the first hop. Credentials and unrelated application settings stay out by construction.
 */
export const INHERITED_PROCESS_ENVIRONMENT_KEYS: readonly string[] = [
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
    'XDG_STATE_HOME',
    /**
     * Linux session context: `systemctl --user`, rootless containers, and desktop keyrings find their sockets through
     * these, so a Terminal on an SSH Host behaves like the user's own login shell.
     */
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    /**
     * Network and trust context for Agent providers and Git behind a proxy or a TLS-inspecting CA. Both cases exist
     * because tools disagree on which spelling they read.
     */
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
    ...agentProviderIds.flatMap((provider) => AGENT_STATE_ENVIRONMENT_KEYS[provider]),
];

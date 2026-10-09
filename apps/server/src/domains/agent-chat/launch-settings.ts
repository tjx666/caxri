import type { AgentLaunchSettings } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';

import type { CodexThreadSettings } from './codex-chat-types';

const SANDBOX_MODES = new Set<string>(['danger-full-access', 'read-only', 'workspace-write']);
const APPROVAL_POLICIES = new Set<string>(['never', 'on-request', 'untrusted']);

/**
 * The TUI options with a structured app-server equivalent, mapped to how each value carries over.
 */
const VALUE_OPTIONS = new Map<string, (settings: ParsedSettings, value: string) => void>([
    ['-m', setModel],
    ['--model', setModel],
    ['-c', (settings, value) => settings.rootArgs.push('-c', value)],
    ['--config', (settings, value) => settings.rootArgs.push('-c', value)],
    ['-p', (settings, value) => settings.rootArgs.push('--profile', value)],
    ['--profile', (settings, value) => settings.rootArgs.push('--profile', value)],
    ['-s', setSandbox],
    ['--sandbox', setSandbox],
    ['-a', setApprovalPolicy],
    ['--ask-for-approval', setApprovalPolicy],
]);

type ParsedSettings = Partial<Omit<CodexThreadSettings, 'rootArgs'>> &
    Pick<CodexThreadSettings, 'rootArgs'>;

function setModel(settings: ParsedSettings, value: string): void {
    settings.model = value;
}

function setSandbox(settings: ParsedSettings, value: string): void {
    if (SANDBOX_MODES.has(value)) settings.sandbox = value as CodexThreadSettings['sandbox'];
}

function setApprovalPolicy(settings: ParsedSettings, value: string): void {
    if (APPROVAL_POLICIES.has(value))
        settings.approvalPolicy = value as CodexThreadSettings['approvalPolicy'];
}

/**
 * Translates the Codex launch settings the user configured for the TUI into app-server thread settings. TUI argv is
 * never appended to `app-server` wholesale: only options with a structured equivalent carry over, and the rest (UI
 * flags such as `--search` or `--no-alt-screen`) have no meaning for a Chat. See `docs/agent-chat.md`.
 *
 * - The autonomy flag keeps its meaning: no approvals and no sandbox.
 * - `--model`, `--sandbox`, and `--ask-for-approval` map to the thread fields of the same name.
 * - `--config` and `--profile` stay root options, placed before `app-server` exactly as the TUI would receive them.
 */
export function codexChatSettings(launch: AgentLaunchSettings): CodexThreadSettings {
    const arguments_ = expandLaunchArguments(launch.args);
    const autonomy = new Set<string>(agentProviderCatalog.codex.autonomyArgs);
    let isAutonomous = false;
    const parsed: ParsedSettings = { rootArgs: [] };
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (autonomy.has(argument)) {
            isAutonomous = true;
            continue;
        }
        const equals = argument.indexOf('=');
        const name = argument.startsWith('--') && equals > 0 ? argument.slice(0, equals) : argument;
        const apply = VALUE_OPTIONS.get(name);
        if (!apply) continue;
        const value = name === argument ? arguments_.at(++index) : argument.slice(equals + 1);
        if (value !== undefined) apply(parsed, value);
    }
    return {
        approvalPolicy: isAutonomous ? 'never' : (parsed.approvalPolicy ?? 'on-request'),
        sandbox: isAutonomous ? 'danger-full-access' : (parsed.sandbox ?? 'workspace-write'),
        ...(parsed.model && { model: parsed.model }),
        rootArgs: parsed.rootArgs,
    };
}

/**
 * The only thread configuration a real-Agent Chat E2E may use: read-only, no approvals to block an unattended run, and
 * no root options, so neither the user's settings nor a profile can widen it.
 */
export const REAL_E2E_CODEX_CHAT_SETTINGS: Readonly<CodexThreadSettings> = Object.freeze({
    approvalPolicy: 'never',
    sandbox: 'read-only',
    rootArgs: [],
});

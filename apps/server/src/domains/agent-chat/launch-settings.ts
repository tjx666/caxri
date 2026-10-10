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

/**
 * Claude Agent SDK query options derived from the provider's TUI launch settings. See `claudeChatSettings`.
 */
export interface ClaudeChatSettings {
    permissionMode: 'acceptEdits' | 'auto' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
    model?: string;
    additionalDirectories: string[];
    allowedTools: string[];
    disallowedTools: string[];
    /**
     * A `--settings` file path or JSON string, passed through unchanged.
     */
    settings?: string;
}

const CLAUDE_PERMISSION_MODES = new Set<string>([
    'acceptEdits',
    'auto',
    'bypassPermissions',
    'default',
    'dontAsk',
    'plan',
]);

type ParsedClaudeSettings = Partial<ClaudeChatSettings> &
    Pick<ClaudeChatSettings, 'additionalDirectories' | 'allowedTools' | 'disallowedTools'>;

/**
 * Claude Code takes tool lists either as one comma- or space-separated value or as repeated values.
 */
function toolList(value: string): string[] {
    return value.split(/[\s,]+/u).filter(Boolean);
}

const CLAUDE_VALUE_OPTIONS = new Map<
    string,
    (settings: ParsedClaudeSettings, value: string) => void
>([
    ['--model', (settings, value) => (settings.model = value)],
    [
        '--permission-mode',
        (settings, value) => {
            if (CLAUDE_PERMISSION_MODES.has(value))
                settings.permissionMode = value as ClaudeChatSettings['permissionMode'];
        },
    ],
    ['--add-dir', (settings, value) => settings.additionalDirectories.push(value)],
    ['--settings', (settings, value) => (settings.settings = value)],
    ['--allowedTools', (settings, value) => settings.allowedTools.push(...toolList(value))],
    ['--allowed-tools', (settings, value) => settings.allowedTools.push(...toolList(value))],
    ['--disallowedTools', (settings, value) => settings.disallowedTools.push(...toolList(value))],
    ['--disallowed-tools', (settings, value) => settings.disallowedTools.push(...toolList(value))],
]);

/**
 * Translates the Claude Code launch settings the user configured for the TUI into Agent SDK options, the same way
 * {@link codexChatSettings} does for Codex: only options with a structured equivalent carry over.
 *
 * - The autonomy flag keeps its meaning: every tool runs without asking.
 * - `--permission-mode`, `--model`, `--add-dir`, `--settings`, and the tool allow and deny lists map to the SDK option of
 *   the same meaning.
 * - Without either, approvals stay manual (`default`) instead of whatever mode the SDK would pick on its own, so a Chat
 *   never runs tools more freely than the user chose.
 */
export function claudeChatSettings(launch: AgentLaunchSettings): ClaudeChatSettings {
    const arguments_ = expandLaunchArguments(launch.args);
    const autonomy = new Set<string>(agentProviderCatalog.claude.autonomyArgs);
    let isAutonomous = false;
    const parsed: ParsedClaudeSettings = {
        additionalDirectories: [],
        allowedTools: [],
        disallowedTools: [],
    };
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (autonomy.has(argument)) {
            isAutonomous = true;
            continue;
        }
        const equals = argument.indexOf('=');
        const name = argument.startsWith('--') && equals > 0 ? argument.slice(0, equals) : argument;
        const apply = CLAUDE_VALUE_OPTIONS.get(name);
        if (!apply) continue;
        const value = name === argument ? arguments_.at(++index) : argument.slice(equals + 1);
        if (value !== undefined) apply(parsed, value);
    }
    return {
        permissionMode: isAutonomous ? 'bypassPermissions' : (parsed.permissionMode ?? 'default'),
        ...(parsed.model && { model: parsed.model }),
        ...(parsed.settings && { settings: parsed.settings }),
        additionalDirectories: parsed.additionalDirectories,
        allowedTools: parsed.allowedTools,
        disallowedTools: parsed.disallowedTools,
    };
}

/**
 * `grok` process arguments derived from the provider's TUI launch settings. `rootArgs` go before the `agent` subcommand
 * and `agentArgs` after it, matching where Grok Build's CLI accepts each option.
 */
export interface GrokChatSettings {
    rootArgs: string[];
    agentArgs: string[];
}

const GROK_ROOT_OPTIONS = new Set<string>(['--permission-mode', '--sandbox']);
const GROK_AGENT_OPTIONS = new Map<string, string>([
    ['-m', '--model'],
    ['--model', '--model'],
    ['--reasoning-effort', '--reasoning-effort'],
    ['--effort', '--reasoning-effort'],
]);

/**
 * Translates the Grok Build launch settings the user configured for the TUI into `grok agent stdio` arguments, the same
 * way {@link codexChatSettings} does for Codex: only options the agent subcommand understands carry over.
 *
 * - The autonomy flag (`--yolo`, or its long form `--always-approve`) keeps its meaning: every tool runs without asking.
 * - `--permission-mode` and `--sandbox` are root options; `--model` and `--reasoning-effort` are agent options.
 * - Without any of them, Grok Build's own defaults apply, which ask before running a tool.
 */
export function grokChatSettings(launch: AgentLaunchSettings): GrokChatSettings {
    const arguments_ = expandLaunchArguments(launch.args);
    const autonomy = new Set<string>([
        ...agentProviderCatalog.grok.autonomyArgs,
        '--always-approve',
    ]);
    let isAutonomous = false;
    const rootArguments: string[] = [];
    const agentArguments: string[] = [];
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index];
        if (autonomy.has(argument)) {
            isAutonomous = true;
            continue;
        }
        const equals = argument.indexOf('=');
        const name = argument.startsWith('--') && equals > 0 ? argument.slice(0, equals) : argument;
        const agentOption = GROK_AGENT_OPTIONS.get(name);
        if (!agentOption && !GROK_ROOT_OPTIONS.has(name)) continue;
        const value = name === argument ? arguments_.at(++index) : argument.slice(equals + 1);
        if (value === undefined) continue;
        if (agentOption) agentArguments.push(agentOption, value);
        else rootArguments.push(name, value);
    }
    if (isAutonomous) agentArguments.unshift('--always-approve');
    return { rootArgs: rootArguments, agentArgs: agentArguments };
}

import { isAbsolute } from 'node:path';

import type { AgentChatPermission, AgentChatPermissionMode } from '@caxri/protocol';
import { agentChatPermissionModes, CaxriError } from '@caxri/protocol';

import { isRecord } from './chat-items';
import { chatPermissionState, supportedChatPermission } from './chat-permissions';
import type { AgentChatSessionHost } from './chat-provider';
import type { CodexThreadSettings } from './codex-chat-types';
import type { JsonRpcConnection } from './json-rpc-connection';
import { codexChatSettings, REAL_E2E_CODEX_CHAT_SETTINGS } from './launch-settings';

type Json = Record<string, unknown>;

export type CodexPermissionSettings = Pick<
    CodexThreadSettings,
    'approvalPolicy' | 'approvalsReviewer' | 'sandbox'
>;

/**
 * Codex's presets: Read Only, Default, Approve for me (approval requests go to Codex's auto-review agent), and Full
 * Access. Read Only keeps `on-request` so Codex can still ask to go beyond the sandbox.
 */
const CODEX_PERMISSIONS: Partial<Record<AgentChatPermissionMode, CodexPermissionSettings>> = {
    readOnly: { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' },
    acceptEdits: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
    },
    auto: {
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        sandbox: 'workspace-write',
    },
    fullAccess: {
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandbox: 'danger-full-access',
    },
};

export function codexPermissionSettings(mode: AgentChatPermissionMode): CodexPermissionSettings {
    const settings = CODEX_PERMISSIONS[mode];
    if (!settings) throw new Error(`Codex has no ${mode} permission`);
    return settings;
}

/**
 * The level that matches Codex's thread settings, if any.
 */
export function codexPermissionMode(
    settings: CodexPermissionSettings,
): AgentChatPermissionMode | undefined {
    return agentChatPermissionModes('codex').find((mode) => {
        const candidate = CODEX_PERMISSIONS[mode];
        return (
            candidate?.approvalPolicy === settings.approvalPolicy &&
            candidate.approvalsReviewer === settings.approvalsReviewer &&
            candidate.sandbox === settings.sandbox
        );
    });
}

const CONFIG_READ_TIMEOUT_MS = 10_000;

/**
 * The `[sandbox_workspace_write]` keys of `config.toml` (as `config/read` reports them) and their `sandboxPolicy`
 * names.
 */
const WORKSPACE_WRITE_FIELDS = {
    writable_roots: 'writableRoots',
    network_access: 'networkAccess',
    exclude_tmpdir_env_var: 'excludeTmpdirEnvVar',
    exclude_slash_tmp: 'excludeSlashTmp',
} as const;

/**
 * The extra workspace-write fields the user configured, as `sandboxPolicy` fields. `turn/start`'s `sandboxPolicy`
 * replaces the thread's whole policy for this turn and later ones, and app-server fills an omitted field with its zero
 * value rather than the user's config: `SandboxPolicy::WorkspaceWrite` marks each field `#[serde(default)]` in
 * https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/permissions.rs. A bare `{
 * type: 'workspaceWrite' }` would therefore drop configured writable roots and network access, while `thread/start` and
 * `thread/resume`, which take the mode name, apply them. Reads the effective config for the Chat's directory with
 * `config/read`. Relative roots are dropped because the policy accepts absolute paths only; a Codex that cannot answer
 * yields no extras, the behavior before this was read.
 */
async function readCodexWorkspaceWrite(connection: JsonRpcConnection, cwd: string): Promise<Json> {
    let table: unknown;
    try {
        const result = await connection.request('config/read', { cwd }, CONFIG_READ_TIMEOUT_MS);
        table =
            isRecord(result) && isRecord(result.config) && result.config.sandbox_workspace_write;
    } catch {
        return {};
    }
    if (!isRecord(table)) return {};
    const extras: Json = {};
    for (const [key, field] of Object.entries(WORKSPACE_WRITE_FIELDS)) {
        const value = table[key];
        if (key === 'writable_roots') {
            if (Array.isArray(value))
                extras[field] = value.filter(
                    (root): root is string => typeof root === 'string' && isAbsolute(root),
                );
        } else if (typeof value === 'boolean') extras[field] = value;
    }
    return extras;
}

/**
 * `turn/start` takes the sandbox as a policy object rather than `thread/start`'s mode name. A workspace-write policy
 * carries the configured extras ({@link readCodexWorkspaceWrite}); the others have none Caxri configures.
 */
function codexSandboxPolicy(sandbox: CodexThreadSettings['sandbox'], workspaceWrite: Json): Json {
    switch (sandbox) {
        case 'read-only': {
            return { type: 'readOnly' };
        }
        case 'workspace-write': {
            return { type: 'workspaceWrite', ...workspaceWrite };
        }
        case 'danger-full-access': {
            return { type: 'dangerFullAccess' };
        }
    }
}

/**
 * The thread settings a Codex Chat opens with: the launch settings, with the Chat's chosen level in place of their
 * sandbox and approvals. A real-Agent E2E keeps its fixed read-only configuration and ignores the choice.
 */
export function codexOpeningSettings(
    host: Pick<AgentChatSessionHost, 'isRealAgentE2E' | 'launch' | 'permission'>,
): { settings: CodexThreadSettings; planMode: boolean } {
    if (host.isRealAgentE2E) return { settings: REAL_E2E_CODEX_CHAT_SETTINGS, planMode: false };
    const launched = codexChatSettings(host.launch);
    const { permissionMode, planMode } = supportedChatPermission('codex', host.permission);
    return {
        settings: permissionMode
            ? { ...launched, ...codexPermissionSettings(permissionMode) }
            : launched,
        planMode,
    };
}

/**
 * One Codex Chat's permission level and plan mode. Like the model, they have no in-place request: a switch rides on the
 * next `turn/start`, whose `approvalPolicy`, `approvalsReviewer`, and `sandboxPolicy` Codex keeps for later turns too.
 * Plan mode is app-server's experimental `collaborationMode`, sent with every turn while it is on, and once more as
 * `default` to turn it off.
 */
export class CodexPermissions {
    private pending: Json = {};

    private planMode: boolean;

    private permissionMode: AgentChatPermissionMode | undefined;

    /**
     * The collaboration mode the thread last ran with, as `thread/resume` reported it or the last turn sent it.
     */
    private threadMode: 'default' | 'plan' | undefined;

    /**
     * The configured workspace-write extras, read once on the first switch to a workspace-write level.
     */
    private workspaceWrite: Json | undefined;

    constructor(
        private readonly host: Pick<AgentChatSessionHost, 'apply' | 'read'>,
        settings: CodexThreadSettings,
        isPlanMode: boolean,
    ) {
        this.planMode = isPlanMode;
        this.permissionMode = codexPermissionMode(settings);
    }

    /**
     * Shows the opened thread's permission and records the collaboration mode Codex reported for it.
     */
    reportOpened(collaborationMode: string | undefined): void {
        if (collaborationMode === 'plan' || collaborationMode === 'default')
            this.threadMode = collaborationMode;
        // Plan mode names the model it runs with; without one it could not be sent, so it must not show as on.
        if (this.host.read().model === undefined) this.planMode = false;
        this.host.apply([
            {
                op: 'state',
                state: chatPermissionState('codex', this.permissionMode, this.planMode),
            },
        ]);
    }

    /**
     * Holds a validated switch for the next turn and shows it right away. Refuses plan mode while the thread has no
     * model, since its `collaborationMode` must name one.
     */
    async set(
        permission: AgentChatPermission,
        connection: JsonRpcConnection,
        cwd: string,
    ): Promise<void> {
        const { permissionMode } = permission;
        if (permission.planMode && !this.planMode && this.host.read().model === undefined)
            throw new CaxriError(
                'CONFLICT',
                'Plan mode is available once Codex reports the model this Chat runs',
            );
        if (permissionMode && permissionMode !== this.permissionMode) {
            const settings = codexPermissionSettings(permissionMode);
            if (settings.sandbox === 'workspace-write')
                this.workspaceWrite ??= await readCodexWorkspaceWrite(connection, cwd);
            this.pending = {
                approvalPolicy: settings.approvalPolicy,
                approvalsReviewer: settings.approvalsReviewer,
                sandboxPolicy: codexSandboxPolicy(settings.sandbox, this.workspaceWrite ?? {}),
            };
            this.permissionMode = permissionMode;
        }
        this.planMode = permission.planMode;
        this.host.apply([
            {
                op: 'state',
                state: chatPermissionState('codex', this.permissionMode, this.planMode),
            },
        ]);
    }

    /**
     * The `turn/start` fields for the next turn. `settings` carries the model and effort the turn runs with, which a
     * collaboration mode must name because it takes precedence over the turn's own.
     */
    turnParameters(settings: { model?: string; effort?: string }): {
        parameters: Json;
        commit: () => void;
    } {
        const pending = this.pending;
        const mode = this.planMode ? 'plan' : 'default';
        const isSendsMode =
            settings.model !== undefined && (mode === 'plan' || this.threadMode === 'plan');
        const parameters: Json = {
            ...pending,
            ...(isSendsMode && {
                collaborationMode: {
                    mode,
                    settings: {
                        model: settings.model,
                        reasoning_effort: settings.effort ?? null,
                        developer_instructions: null,
                    },
                },
            }),
        };
        return {
            parameters,
            commit: () => {
                if (this.pending === pending) this.pending = {};
                if (isSendsMode) this.threadMode = mode;
            },
        };
    }
}

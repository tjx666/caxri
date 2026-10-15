import type {
    CanUseTool,
    HookCallbackMatcher,
    HookEvent,
    Options,
    SpawnedProcess,
    SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentChatSessionHost } from './chat-provider';
import { AgentChatStartError } from './chat-provider';
import type { ClaudeChatSettings } from './launch-settings';

/**
 * Opening a Claude Chat: the Agent SDK options Caxri launches Claude Code with, and the closed start failure a
 * handshake that never completed reports.
 */

export interface ClaudeQueryOptionsInput {
    host: AgentChatSessionHost;
    settings: ClaudeChatSettings;
    /**
     * The bound Agent Session to `--resume`; a new conversation presets `sessionId` instead.
     */
    resumeId: string | undefined;
    /**
     * The assistant message uuid "Edit from here" rewound the resumed conversation to, so Claude Code drops later
     * messages from its context.
     */
    resumeAt: string | undefined;
    sessionId: string;
    spawn: (spawnOptions: SpawnOptions) => SpawnedProcess;
    canUseTool: CanUseTool;
    hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

export function claudeQueryOptions({
    host,
    settings,
    resumeId,
    resumeAt,
    sessionId,
    spawn,
    canUseTool,
    hooks,
}: ClaudeQueryOptionsInput): Options {
    return {
        cwd: host.cwd,
        pathToClaudeCodeExecutable: host.executable,
        spawnClaudeCodeProcess: spawn,
        env: {
            ...host.environment,
            CLAUDE_AGENT_SDK_CLIENT_APP: `caxri/${host.clientVersion}`,
            // Reports `system/session_state_changed`, the authoritative turn boundary.
            CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
        },
        ...(resumeId ? { resume: resumeId } : { sessionId }),
        ...(resumeId && resumeAt !== undefined && { resumeSessionAt: resumeAt }),
        /**
         * Claude Code backs up each file before its first edit in a turn, keyed by the prompt's uuid, so "Edit from
         * here" can put the files back with `rewindFiles`. The backups persist with the session.
         */
        enableFileCheckpointing: true,
        includePartialMessages: true,
        includeHookEvents: true,
        // Subagent text and thinking reach the task tab, not only their tool calls.
        forwardSubagentText: true,
        /**
         * The Chat stops tasks one at a time, so an interrupt must spare background subagents too. A background shell
         * survives an interrupt either way and gets no task event (verified on Claude Code 2.1.296, #1611); it ends
         * only with `stop_task` or when the CLI exits.
         */
        perTaskStopAffordance: true,
        systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            ...(host.instructions && { append: host.instructions }),
        },
        tools: { type: 'preset', preset: 'claude_code' },
        permissionMode: settings.permissionMode,
        /**
         * Required for `bypassPermissions` at launch and for a later switch to it, so the composer's Full access level
         * works on a Chat that started at another level. It enables nothing on its own.
         */
        allowDangerouslySkipPermissions: true,
        ...(settings.model && { model: settings.model }),
        ...(settings.settings && { settings: settings.settings }),
        ...(settings.additionalDirectories.length > 0 && {
            additionalDirectories: settings.additionalDirectories,
        }),
        ...(settings.allowedTools.length > 0 && { allowedTools: settings.allowedTools }),
        ...(settings.disallowedTools.length > 0 && {
            disallowedTools: settings.disallowedTools,
        }),
        canUseTool,
        hooks,
    };
}

/**
 * Why a handshake that never completed failed. `spawnErrorCode` reports how the process failed to start, which explains
 * the failure better than the handshake error does.
 */
export function claudeStartError(
    spawnErrorCode: string | undefined,
    isResume: boolean,
): AgentChatStartError {
    if (spawnErrorCode !== undefined)
        return spawnErrorCode === 'ENOENT'
            ? new AgentChatStartError('executable_not_found', 'Claude CLI was not found')
            : new AgentChatStartError('spawn_failed', 'Claude could not be started');
    if (isResume)
        return new AgentChatStartError(
            'resume_failed',
            'Claude could not resume this conversation',
        );
    return new AgentChatStartError('handshake_failed', 'Claude did not complete its handshake');
}

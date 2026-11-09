import type {
    CanUseTool,
    Options,
    SpawnedProcess,
    SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';

import { CAXRI_CLAUDE_ENTRYPOINT } from '../../../agents';
import type { AgentChatSessionHost, AgentChatTranscript } from '../../chat-provider';
import { AgentChatStartError } from '../../chat-provider';
import type { ClaudeChatSettings } from '../../launch-settings';
import { ProviderProcess } from '../../provider-process';
import { claudeEffortHooks } from './models';
import { withClaudeShellHooks } from './shell-hooks';

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
}

export function claudeQueryOptions({
    host,
    settings,
    resumeId,
    resumeAt,
    sessionId,
    spawn,
    canUseTool,
}: ClaudeQueryOptionsInput): Options {
    return {
        cwd: host.cwd,
        pathToClaudeCodeExecutable: host.executable,
        spawnClaudeCodeProcess: spawn,
        env: {
            ...host.environment,
            CLAUDE_AGENT_SDK_CLIENT_APP: `caxri/${host.clientVersion}`,
            CLAUDE_CODE_ENTRYPOINT: CAXRI_CLAUDE_ENTRYPOINT,
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
        /**
         * Claude Code echoes each prompt when it takes it in, which is when a steered prompt finally joins the turn
         * (`ClaudeSteers`).
         */
        extraArgs: { 'replay-user-messages': null },
        // Subagent text and thinking reach the task tab, not only their tool calls.
        forwardSubagentText: true,
        /**
         * Claude Code's next-message suggestion after each turn (`applyClaudePromptSuggestion`). It reuses the turn's
         * prompt cache, and Claude Code itself skips it on the first turn, in plan mode, near the plan's usage limit,
         * and when the user turned `promptSuggestionEnabled` off.
         */
        promptSuggestions: true,
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
        ...(settings.effort && { effort: settings.effort }),
        ...(settings.settings && { settings: settings.settings }),
        ...(settings.pluginDirectories?.length && {
            plugins: settings.pluginDirectories.map((path) => ({ type: 'local' as const, path })),
        }),
        ...(settings.additionalDirectories.length > 0 && {
            additionalDirectories: settings.additionalDirectories,
        }),
        ...(settings.allowedTools.length > 0 && { allowedTools: settings.allowedTools }),
        ...(settings.disallowedTools.length > 0 && {
            disallowedTools: settings.disallowedTools,
        }),
        canUseTool,
        /**
         * The effort hooks report the effort each turn runs at; the shell and worktree hooks report the lifecycle a PTY
         * Agent's hook bridge would.
         */
        hooks: withClaudeShellHooks(
            claudeEffortHooks((operations) => host.apply(operations)),
            (event) => host.observeLifecycle(event),
        ),
    };
}

/**
 * Starts the Claude Code process the SDK asks for through {@link ProviderProcess}, reporting how a failed start failed
 * (`spawnErrorCode`, read by {@link claudeStartError}).
 */
export function spawnClaudeProcess(
    host: Pick<AgentChatSessionHost, 'cwd' | 'processGroups' | 'spawnProcess'>,
    spawnOptions: SpawnOptions,
    onSpawnError: (code: string) => void,
): ProviderProcess {
    const providerProcess = new ProviderProcess({
        executable: spawnOptions.command,
        args: spawnOptions.args,
        cwd: spawnOptions.cwd ?? host.cwd,
        environment: spawnOptions.env,
        spawnProcess: host.spawnProcess,
        processGroups: host.processGroups,
    });
    providerProcess.child.once('error', (error: NodeJS.ErrnoException) => {
        onSpawnError(error.code ?? 'unknown');
    });
    return providerProcess;
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

/**
 * The transcript a resumed Chat replays its history from, because Claude Code does not replay a resumed conversation
 * over the protocol. A bound Agent Session without one cannot resume, so the start fails before Claude Code spawns.
 */
export async function readClaudeResumeTranscript(
    host: Pick<AgentChatSessionHost, 'readTranscript'>,
    resumeId: string | undefined,
): Promise<AgentChatTranscript | undefined> {
    if (!resumeId) return undefined;
    const transcript = await host.readTranscript();
    if (!transcript)
        throw new AgentChatStartError('resume_failed', 'Claude could not find this conversation');
    return transcript;
}

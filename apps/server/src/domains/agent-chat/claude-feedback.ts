import { randomUUID } from 'node:crypto';

import type { AgentChatItem } from '@caxri/protocol';

import { clip, isRecord, stringField } from './chat-items';

type Json = Record<string, unknown>;
type Notice = Extract<AgentChatItem, { type: 'notice' }>;
type FeedbackScope = 'agent' | 'session';

/**
 * Claude's readable block feedback retains the tool id that triggered it, while raw Hook lifecycle messages do not.
 * Persisted non-blocking Hook errors use a different attachment field, so both envelopes are normalized here.
 */
export function claudeFeedbackToolUseId(input: Json): string | undefined {
    const attachment = isRecord(input.attachment) ? input.attachment : undefined;
    const value =
        stringField(input.tool_use_id) ??
        stringField(input.toolUseId) ??
        stringField(attachment?.toolUseID) ??
        stringField(attachment?.toolUseId);
    return value ? clip(value, 200) : undefined;
}

/**
 * Strip only the provider-owned command envelope, never arbitrary markup in a user's message.
 */
function commandText(content: unknown): string {
    const value = stringField(content) ?? '';
    return /^<local-command-stdout>([\s\S]*)<\/local-command-stdout>$/.exec(value)?.[1] ?? value;
}

/**
 * Hook control JSON is not a readable failure reason. Keep ordinary diagnostic text intact.
 */
function diagnostic(value: unknown): string {
    const text = stringField(value)?.trim() ?? '';
    if (!text) return '';
    try {
        const parsed: unknown = JSON.parse(text);
        if (isRecord(parsed))
            return stringField(parsed.stopReason) ?? stringField(parsed.reason) ?? '';
        return '';
    } catch {
        return text;
    }
}

/**
 * Live SDK and persisted Claude records use different envelopes for the same feedback. Verified with Claude Code
 * 2.1.301: blocking reasons are persisted under promptSubmitEnding, and mod commands as system/local_command while live
 * delivery uses assistant/local_command_run. Share this mapping so switching from Terminal cannot lose feedback.
 */
export function claudeFeedbackItems(
    input: Json,
    turnId?: string | null,
    scope: FeedbackScope = 'session',
): Notice[] {
    const attachment = isRecord(input.attachment) ? input.attachment : undefined;
    const message: Json =
        input.type === 'attachment' && attachment?.type === 'hook_non_blocking_error'
            ? {
                  subtype: 'hook_response',
                  uuid: input.uuid,
                  outcome: 'error',
                  hook_name: attachment.hookName,
                  exit_code: attachment.exitCode,
                  stderr: attachment.stderr,
                  stdout: attachment.stdout,
              }
            : input;
    let content: string;
    let title: string | undefined;
    let kind: Notice['kind'] = 'output';
    const command = message.local_command_run ?? message.commandRun;
    if (
        isRecord(command) &&
        (message.type === 'assistant' || message.subtype === 'local_command')
    ) {
        const name = stringField(command.command);
        const plugin = stringField(command.plugin);
        title =
            [plugin, name ? `/${name}` : undefined].filter(Boolean).join(' · ') || 'Command output';
        content = commandText(message.local_command_source ?? message.content);
        kind = 'warning';
    } else {
        switch (message.subtype) {
            case 'informational': {
                const live = isRecord(message.prompt_submit_outcome)
                    ? message.prompt_submit_outcome
                    : undefined;
                const saved = isRecord(message.promptSubmitEnding)
                    ? message.promptSubmitEnding.ending
                    : undefined;
                const outcome = live ?? (isRecord(saved) ? saved : undefined);
                const isBlocked =
                    outcome?.kind === 'blocked_by_hook' ||
                    outcome?.kind === 'dropped_by_hook' ||
                    message.prevent_continuation === true;
                content =
                    (isBlocked ? stringField(outcome?.reason) : undefined) ??
                    stringField(message.content) ??
                    '';
                kind =
                    message.level === 'error'
                        ? 'error'
                        : isBlocked || message.level === 'warning'
                          ? 'warning'
                          : 'output';
                title = isBlocked
                    ? 'Input blocked by Hook'
                    : kind === 'warning'
                      ? 'Claude Code warning'
                      : kind === 'error'
                        ? 'Claude Code error'
                        : undefined;
                break;
            }
            case 'local_command':
            case 'local_command_output': {
                content = commandText(message.content);
                title = 'Command output';
                break;
            }
            case 'model_refusal_fallback':
            case 'model_refusal_no_fallback': {
                content = stringField(message.content) ?? '';
                kind = 'warning';
                title = 'Model response declined';
                break;
            }
            case 'hook_response': {
                if (message.outcome !== 'error') return [];
                const name = clip(stringField(message.hook_name) ?? 'Unknown', 100);
                const code =
                    typeof message.exit_code === 'number' && Number.isSafeInteger(message.exit_code)
                        ? ` (exit code ${message.exit_code})`
                        : '';
                title = `${scope === 'session' ? 'Session Hook' : 'Hook'} "${name}" failed${code}`;
                content =
                    diagnostic(message.stderr) ||
                    diagnostic(message.output) ||
                    diagnostic(message.stdout) ||
                    'No failure details were provided.';
                kind = 'error';
                break;
            }
            default:
                return [];
        }
    }
    if (!content.trim()) return [];
    const id = clip(`claude-output:${stringField(message.uuid) ?? randomUUID()}`, 180);
    const items: Notice[] = [];
    for (let offset = 0; offset < content.length; offset += 2_000) {
        items.push({
            id: `${id}:${offset}`,
            ...(turnId && { turnId }),
            type: 'notice',
            kind,
            ...(title && { title: clip(title, 200) }),
            message: content.slice(offset, offset + 2_000),
        });
    }
    return items;
}

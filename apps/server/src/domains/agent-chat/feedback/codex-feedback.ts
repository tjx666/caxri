import type { AgentChatItem } from '@caxri/protocol';

import { clip, isRecord, noticeChunks, stringField } from '../chat-items';
import type { AgentChatSessionHost, ChatProviderNotice } from '../chat-provider';
import { chatTextDigest } from '../chat-turn-answer';

type Json = Record<string, unknown>;
type Notice = Extract<AgentChatItem, { type: 'notice' }>;

/**
 * Which Codex app-server notification a Chat notice came from, as `agent_chat.provider_notice` records it.
 */
type CodexNoticeSource =
    | 'hook'
    | 'warning'
    | 'configWarning'
    | 'guardianWarning'
    | 'deprecationNotice'
    | 'modelRerouted'
    | 'modelVerification';

type CodexNoticeEvent = ChatProviderNotice & { source: CodexNoticeSource };

const HOOK_EVENTS = new Set([
    'preModelRequest',
    'postModelRequest',
    'preToolUse',
    'permissionRequest',
    'postToolUse',
    'preCompact',
    'postCompact',
    'sessionStart',
    'sessionEnd',
    'userPromptSubmit',
    'subagentStart',
    'subagentStop',
    'stop',
    'interrupt',
]);

const REROUTE_REASONS: Partial<Record<string, string>> = {
    highRiskCyberActivity: 'it detected possible high-risk cybersecurity activity',
};

/**
 * Codex's own TUI copy for this verification (`TRUSTED_ACCESS_FOR_CYBER_VERIFICATION_WARNING` in codex-rs/tui).
 */
const VERIFICATIONS: Partial<Record<string, string>> = {
    trustedAccessForCyber:
        'Your conversations have multiple flags for possible cybersecurity risk. Responses may take longer because extra safety checks are on. To get authorized for security work, join the Trusted Access for Cyber program: https://chatgpt.com/cyber',
};

const WARNING_TITLES: Partial<Record<string, { source: CodexNoticeSource; title: string }>> = {
    warning: { source: 'warning', title: 'Codex warning' },
    configWarning: { source: 'configWarning', title: 'Codex configuration warning' },
    guardianWarning: { source: 'guardianWarning', title: 'Codex warning' },
    deprecationNotice: { source: 'deprecationNotice', title: 'Codex deprecation notice' },
};

function known(value: string | undefined, values: { has(value: string): boolean }): string | null {
    if (value === undefined) return null;
    return values.has(value) ? value : 'other';
}

function lines(...values: unknown[]): string {
    return values
        .map((value) => stringField(value)?.trim())
        .filter(Boolean)
        .join('\n\n');
}

function entryText(run: Json, kinds: readonly string[]): string {
    const wanted = new Set(kinds);
    const entries = Array.isArray(run.entries) ? run.entries.filter(isRecord) : [];
    return lines(
        ...entries
            .filter((entry) => wanted.has(stringField(entry.kind) ?? ''))
            .map((entry) => entry.text),
    );
}

/**
 * A finished Hook run that needs the user's attention. Codex reports every run, but like Claude Chat only a failure, a
 * block, or a stop is conversation content: a Hook that ran cleanly stays silent. Codex reports no exit code; its
 * failure entries carry the reason (`hook exited with code N` when the Hook printed nothing).
 */
function hookNotice(
    run: Json,
): { title: string; kind: Notice['kind']; content: string } | undefined {
    const event = stringField(run.eventName) ?? '';
    const name = clip(event.charAt(0).toUpperCase() + event.slice(1) || 'Unknown', 100);
    switch (run.status) {
        case 'failed': {
            return {
                title: `Hook "${name}" failed`,
                kind: 'error',
                content:
                    entryText(run, ['error', 'warning']) || 'No failure details were provided.',
            };
        }
        case 'blocked': {
            return {
                title: `Hook "${name}" blocked the action`,
                kind: 'warning',
                content:
                    entryText(run, ['feedback', 'stop', 'warning']) || 'No reason was provided.',
            };
        }
        case 'stopped': {
            return {
                title: `Hook "${name}" stopped the turn`,
                kind: 'warning',
                content:
                    entryText(run, ['stop', 'feedback', 'warning']) || 'No reason was provided.',
            };
        }
        default: {
            return undefined;
        }
    }
}

/**
 * Maps a Codex app-server notification that is feedback for the user (a Hook that failed or blocked, a runtime or
 * configuration warning, a model reroute, a required verification) to Chat notices, or `undefined` for any other
 * method. `items` is empty for a notification of a known method that needs no notice, such as a Hook that completed.
 * Ids derive from the turn and the run or text, so a repeated delivery replaces the notice instead of adding another.
 */
function mapCodexNotice(
    method: string,
    parameters: Json,
    turnId: string | undefined,
): { items: Notice[]; event: CodexNoticeEvent } | undefined {
    const scope = turnId ? clip(turnId, 200) : 'thread';
    const base = { ...(turnId && { turnId: clip(turnId, 200) }) };
    const event = { hookEvent: null, hookStatus: null, reason: null };
    switch (method) {
        case 'hook/completed': {
            const run = isRecord(parameters.run) ? parameters.run : {};
            const notice = hookNotice(run);
            const runId = clip(`${stringField(run.id) ?? 'hook'}:${String(run.startedAt)}`, 200);
            return {
                items: notice
                    ? noticeChunks(`codex-hook:${scope}:${runId}`, notice.content, {
                          ...base,
                          kind: notice.kind,
                          title: notice.title,
                      })
                    : [],
                event: {
                    ...event,
                    source: 'hook',
                    hookEvent: known(stringField(run.eventName), HOOK_EVENTS),
                    hookStatus: known(
                        stringField(run.status),
                        new Set(['running', 'completed', 'failed', 'blocked', 'stopped']),
                    ),
                },
            };
        }
        case 'model/rerouted': {
            const reason = stringField(parameters.reason);
            const why = (reason && REROUTE_REASONS[reason]) ?? 'Codex rerouted the request';
            const from = clip(stringField(parameters.fromModel) ?? 'the selected model', 100);
            const to = clip(stringField(parameters.toModel) ?? 'another model', 100);
            return {
                items: noticeChunks(
                    `codex-reroute:${scope}`,
                    `Codex answered with ${to} instead of ${from} because ${why}.`,
                    { ...base, kind: 'warning', title: 'Model changed' },
                ),
                event: {
                    ...event,
                    source: 'modelRerouted',
                    reason: known(reason, new Set(Object.keys(REROUTE_REASONS))),
                },
            };
        }
        case 'model/verification': {
            const verifications = Array.isArray(parameters.verifications)
                ? parameters.verifications.filter((value) => typeof value === 'string')
                : [];
            const content = lines(...verifications.map((value) => VERIFICATIONS[value]));
            return {
                items: content
                    ? noticeChunks(`codex-verification:${scope}`, content, {
                          ...base,
                          kind: 'warning',
                          title: 'Account verification needed',
                      })
                    : [],
                event: {
                    ...event,
                    source: 'modelVerification',
                    reason: known(verifications[0], new Set(Object.keys(VERIFICATIONS))),
                },
            };
        }
        default: {
            const warning = WARNING_TITLES[method];
            if (!warning) return undefined;
            const content = lines(
                parameters.message ?? parameters.summary,
                parameters.details,
                method === 'configWarning' ? parameters.path : undefined,
            );
            // Codex repeats a warning, such as an ignored config key, every time it applies; one notice per text and turn.
            const id = `codex-${method}:${scope}:${chatTextDigest(content).slice(0, 16)}`;
            return {
                items: content
                    ? noticeChunks(id, content, { ...base, kind: 'warning', title: warning.title })
                    : [],
                event: { ...event, source: warning.source },
            };
        }
    }
}

/**
 * Shows a Codex feedback notification in the Chat and logs that it did. Any other method, and a feedback notification
 * that needs no notice (a Hook that completed), is neither shown nor logged: MCP startup progress is not conversation
 * content. Only `hook/*` and `model/*` carry a turn; a warning joins the turn that is running when it arrives.
 */
export function applyCodexNotice(
    host: Pick<AgentChatSessionHost, 'apply' | 'onProviderNotice' | 'read'>,
    method: string,
    parameters: Json,
    turnId: string | undefined,
): void {
    const mapped = mapCodexNotice(method, parameters, turnId ?? host.read().activeTurnId);
    if (!mapped?.items.length) return;
    host.apply(mapped.items.map((item) => ({ op: 'upsertItem', item })));
    host.onProviderNotice(mapped.event);
}

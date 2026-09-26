import type { AgentSystemEventKind, AgentSystemEventStatus } from '@caxri/protocol';

import { timelineSummary, timelineText } from './timeline-model';

export interface SystemEventProjection {
    detail?: string;
    kind: AgentSystemEventKind;
    status?: AgentSystemEventStatus;
    summary: string;
}

const TASK_STATUSES: Readonly<Record<string, AgentSystemEventStatus>> = {
    completed: 'completed',
    failed: 'failed',
    killed: 'killed',
    running: 'running',
    stopped: 'killed',
};

function tagContent(text: string, tag: string): string | undefined {
    const match = new RegExp(String.raw`<${tag}>([\s\S]*?)</${tag}>`, 'u').exec(text);
    return match?.[1];
}

function combinedDetail(parts: Array<string | undefined>): string | undefined {
    const joined = parts.filter((part): part is string => Boolean(part?.trim())).join('\n\n');
    return timelineText(joined, 2_048);
}

/**
 * Recognizes harness-injected envelopes a provider CLI writes into a user turn instead of text the reader typed: a
 * background task completion, a `/command` echo (with its local stdout and any caveat), or a `!`-prefixed bash-mode
 * echo. Checked in this order because a command echo and a caveat can appear in the same turn, and the command is the
 * more informative label.
 *
 * `<system-reminder>` is deliberately not classified here: `stripInjectedTranscriptContent` already erases it from the
 * visible message, so a turn made of only a reminder falls through as empty text rather than becoming a system event,
 * which is what hides it from the timeline entirely.
 */
export function classifySystemEvent(rawText: string): SystemEventProjection | undefined {
    const taskNotification = tagContent(rawText, 'task-notification');
    if (taskNotification !== undefined) {
        /**
         * The envelope nests `task-id`, `tool-use-id`, `output-file`, `status`, `summary`, and for a background Agent
         * its `result`. Only the human summary, the outcome, and the result are projected: identifiers mean nothing to
         * a reader, and the output file is a local path that must never leave the computer.
         */
        const rawStatus = tagContent(taskNotification, 'status')?.trim().toLowerCase();
        const status = rawStatus ? (TASK_STATUSES[rawStatus] ?? 'unknown') : undefined;
        const summary = timelineSummary(
            tagContent(taskNotification, 'summary'),
            'Background task finished',
        );
        const detail = combinedDetail([tagContent(taskNotification, 'result')]);
        return {
            kind: 'taskNotification',
            summary,
            ...(status && { status }),
            ...(detail && detail !== summary && { detail }),
        };
    }
    const commandName = tagContent(rawText, 'command-name');
    const commandMessage = tagContent(rawText, 'command-message');
    if (commandName !== undefined || commandMessage !== undefined) {
        const commandArguments = tagContent(rawText, 'command-args');
        const stdout = tagContent(rawText, 'local-command-stdout');
        const caveat = tagContent(rawText, 'local-command-caveat');
        const label = [commandName, commandMessage].map((value) => value?.trim()).find(Boolean);
        const summary = timelineSummary(
            [label, commandArguments?.trim()].filter(Boolean).join(' '),
            'Slash command',
        );
        const detail = combinedDetail([stdout, caveat]);
        return { kind: 'slashCommand', summary, ...(detail && { detail }) };
    }
    const bashInput = tagContent(rawText, 'bash-input');
    if (bashInput !== undefined) {
        const stdout = tagContent(rawText, 'bash-stdout');
        const stderr = tagContent(rawText, 'bash-stderr');
        const summary = timelineSummary(bashInput, 'Bash command');
        const detail = combinedDetail([stdout, stderr]);
        return { kind: 'bashCommand', summary, ...(detail && { detail }) };
    }
    const caveat = tagContent(rawText, 'local-command-caveat');
    if (caveat !== undefined) {
        const summary = timelineSummary(caveat, 'Caveat');
        const detail = combinedDetail([caveat]);
        return { kind: 'caveat', summary, ...(detail && detail !== summary && { detail }) };
    }
    return undefined;
}

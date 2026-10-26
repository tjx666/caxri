import type { AgentChatWorkItem, AgentToolKind, AgentToolPresentation } from '@caxri/protocol';
import {
    agentChatItemStatusLabel,
    agentChatWorkVerb,
    agentToolActiveLabel,
    describeAgentChatWork,
    describeAgentChatWorkRow,
    isAgentChatWorkRunning,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';

/**
 * What one Chat work row shows and announces. The rules mirror Desktop's work row: the verb is present tense while the
 * item runs, including a command still waiting for approval (`Running echo approved`), and the settled verb after (`Ran
 * echo approved`, `Failed to run`); a command titles itself with the Agent's description when it wrote one, and a
 * settled command adds its `Background` tag and non-zero `Exit N`.
 */
export interface AgentChatWorkRowPresentation {
    /**
     * The screen reader label: the visible title, the trailing facts, how a step that did not complete ended, and the
     * action.
     */
    accessibilityLabel: string;
    /**
     * Whether the command was moved to the background, shown as a `Background` tag.
     */
    background: boolean;
    /**
     * A settled command's non-zero exit code, shown as `Exit N` in the danger color; absent for success or no code.
     */
    failedExitCode?: number;
    isCodeSubject: boolean;
    isRunning: boolean;
    kind: AgentToolKind;
    subject?: string;
    verb: string;
}

/**
 * The verb a work row and its detail title share. A subagent's tool call returns while the subagent keeps working, so
 * its settled `Ran agent` would contradict a spinner; the linked task still running keeps the present tense (`Running
 * agent`).
 */
export function agentChatWorkRowVerb(
    item: AgentChatWorkItem,
    presentation: AgentToolPresentation,
    t: Translate = translate,
    isTaskRunning = false,
): string {
    return isTaskRunning
        ? agentToolActiveLabel(presentation, t)
        : agentChatWorkVerb(item, presentation, t);
}

/**
 * `isTaskRunning`: the background task this row started still runs, so the row reads as running even though the item
 * itself settled.
 *
 * `hasServerIcon`: the row draws its MCP server's own icon, so the title is the tool alone (`Web search exa`) as on
 * Desktop; without an icon the server's name stays in the title so the row still says which server answered.
 */
export function agentChatWorkRowPresentation(
    item: AgentChatWorkItem,
    t: Translate = translate,
    hasServerIcon = false,
    isTaskRunning = false,
): AgentChatWorkRowPresentation {
    const presentation = hasServerIcon
        ? describeAgentChatWorkRow(item, t)
        : describeAgentChatWork(item, t);
    const isRunning = isAgentChatWorkRunning(item) || isTaskRunning;
    const verb = agentChatWorkRowVerb(item, presentation, t, isTaskRunning);
    const isSettledCommand = item.type === 'command' && !isRunning;
    const isBackground = isSettledCommand && item.background === true;
    const failedExitCode =
        isSettledCommand && item.exitCode !== undefined && item.exitCode !== 0
            ? item.exitCode
            : undefined;
    const facts = [
        ...(isBackground ? [t('chat.work.background')] : []),
        ...(failedExitCode === undefined ? [] : [t('chat.work.exit', { code: failedExitCode })]),
        ...(item.type === 'reasoning' || item.status === 'running' || item.status === 'completed'
            ? []
            : [agentChatItemStatusLabel(item.status, t)]),
    ];
    const title = presentation.subject ? `${verb} ${presentation.subject}` : verb;
    return {
        accessibilityLabel: [title, ...facts, t('chat.work.openDetail')]
            .map((part) => `${part}.`)
            .join(' '),
        background: isBackground,
        ...(failedExitCode !== undefined && { failedExitCode }),
        isCodeSubject: presentation.isCodeSubject,
        isRunning,
        kind: presentation.kind,
        ...(presentation.subject !== undefined && { subject: presentation.subject }),
        verb,
    };
}

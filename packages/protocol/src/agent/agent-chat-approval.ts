import type { AgentChatItem } from './agent-chat-contract.js';
import type { AgentChatRequest } from './agent-chat-requests.js';
import { agentToolActiveLabel, describeAgentTool } from './agent-tool-presentation.js';

/**
 * An approval request: everything a provider asks before acting, as opposed to a question it asks the user.
 */
export type AgentChatApprovalRequest = Extract<
    AgentChatRequest,
    { kind: 'command' | 'fileChange' | 'tool' }
>;

export type AgentChatApprovalDecision = 'accept' | 'acceptForSession' | 'decline';

/**
 * Claude Code asks to leave plan mode through this tool; its summary is the plan.
 */
export const AGENT_CHAT_EXIT_PLAN_TOOL = 'ExitPlanMode';

export function isAgentChatApprovalRequest(
    request: AgentChatRequest,
): request is AgentChatApprovalRequest {
    return request.kind !== 'question';
}

/**
 * The standing-approval button's label for its scope: a Chat remembers it for the Chat, a Terminal Agent's attention
 * request for the Session. Shared so the Desktop Chat, the Mobile Chat, and the Mobile Terminal attention card read the
 * same.
 */
export function agentApprovalAlwaysAllowLabel(scope: 'Chat' | 'Session'): string {
    return `Always Allow in This ${scope}`;
}

/**
 * The one-time allow and deny labels for an approval whose action is not known beyond "use this tool", such as a
 * Terminal Agent's permission request. A Chat names the outcome instead (`Run`, `Apply Changes`); see
 * {@link agentChatApprovalChoices}.
 */
export const AGENT_APPROVAL_ALLOW_LABEL = 'Allow';
export const AGENT_APPROVAL_DENY_LABEL = 'Deny';

/**
 * What accepting does, named by the outcome the user gets rather than the protocol verb: a command runs, a file change
 * is applied, plan mode ends, and any other tool (or a command's network access) is allowed.
 */
function acceptLabel(request: AgentChatApprovalRequest): string {
    switch (request.kind) {
        case 'command': {
            return request.networkHost ? AGENT_APPROVAL_ALLOW_LABEL : 'Run';
        }
        case 'fileChange': {
            return 'Apply Changes';
        }
        case 'tool': {
            return request.name === AGENT_CHAT_EXIT_PLAN_TOOL
                ? 'Start Building'
                : AGENT_APPROVAL_ALLOW_LABEL;
        }
    }
}

/**
 * The approval buttons to show, in a fixed order, each labeled by its outcome (`Run`, `Apply Changes`, `Allow`). The
 * provider may restrict them through `decisions`; `cancel` is never a button because declining already answers the
 * request without stopping the turn. Declining plan mode keeps the Agent planning, so it says so.
 */
export function agentChatApprovalChoices(
    request: AgentChatApprovalRequest,
): Array<{ decision: AgentChatApprovalDecision; label: string }> {
    const isPlan = request.kind === 'tool' && request.name === AGENT_CHAT_EXIT_PLAN_TOOL;
    const choices: Array<{ decision: AgentChatApprovalDecision; label: string }> = [
        { decision: 'accept', label: acceptLabel(request) },
        { decision: 'acceptForSession', label: agentApprovalAlwaysAllowLabel('Chat') },
        { decision: 'decline', label: isPlan ? 'Keep Planning' : AGENT_APPROVAL_DENY_LABEL },
    ];
    const allowed = request.decisions;
    return choices.filter((choice) => !allowed || allowed.includes(choice.decision));
}

/**
 * A tool subject longer than this stays out of the approval title; the card shows it in full below.
 */
const REQUEST_TITLE_SUBJECT_LENGTH = 60;

/**
 * What a tool approval asks to do, in the timeline's words rather than the provider's identifier: `Allow editing
 * app.ts?`, `Allow create_issue from github?`. A long or multi-line subject is left to the card body; a tool the shared
 * table does not know keeps its name.
 */
function agentChatToolRequestTitle(request: { name: string; summary?: string }): string {
    const presentation = describeAgentTool(request);
    if (presentation.kind === 'mcp' && presentation.subject)
        return `Allow ${presentation.subject} from ${presentation.label}?`;
    const subject = presentation.subject;
    if (!subject || presentation.kind === 'other') return `Allow ${request.name}?`;
    const gerund = agentToolActiveLabel(presentation);
    const action = `${gerund.charAt(0).toLowerCase()}${gerund.slice(1)}`;
    return subject.length <= REQUEST_TITLE_SUBJECT_LENGTH && !subject.includes('\n')
        ? `Allow ${action} ${subject}?`
        : `Allow ${action}?`;
}

/**
 * The approval or question card's heading. `providerName` is the provider catalog's display name, which a question
 * names as the one asking.
 */
export function agentChatRequestTitle(request: AgentChatRequest, providerName: string): string {
    switch (request.kind) {
        case 'command': {
            return request.networkHost
                ? `Allow network access to ${request.networkHost}?`
                : 'Run this command?';
        }
        case 'fileChange': {
            return 'Apply these file changes?';
        }
        case 'tool': {
            return request.name === AGENT_CHAT_EXIT_PLAN_TOOL
                ? 'Start with this plan?'
                : agentChatToolRequestTitle(request);
        }
        case 'question': {
            return request.questions.length === 1
                ? `${providerName} has a question`
                : `${providerName} has ${request.questions.length} questions`;
        }
    }
}

/**
 * What a turn blocked on the user is waiting for: an approval of something the Agent wants to do, or an answer to its
 * question. The first pending request decides, since that is the card the user sees first.
 */
export function agentChatWaitingText(requests: readonly AgentChatRequest[]): string {
    const first = requests.at(0);
    return first && isAgentChatApprovalRequest(first)
        ? 'Waiting for your approval'
        : 'Waiting for your answer';
}

/**
 * Timeline record of the answers given to a question request. The request card disappears once answered, and without
 * this record the conversation would show the Agent acting on a choice the transcript never mentions. Server Core
 * records it; the Desktop composer shows the same record while the answer is still on its way.
 */
export function agentChatAnsweredNotice(
    request: AgentChatRequest | undefined,
    turnId: string | undefined,
    answers: Readonly<Record<string, readonly string[]>>,
): AgentChatItem | undefined {
    if (request?.kind !== 'question') return undefined;
    const lines = request.questions.flatMap((question) => {
        if (!Object.hasOwn(answers, question.id)) return [];
        const chosen = answers[question.id];
        if (chosen.length === 0) return [];
        return [`${question.header || question.question}: ${chosen.join(', ')}`];
    });
    if (lines.length === 0) return undefined;
    return {
        id: `answer:${request.id}`.slice(0, 200),
        ...(turnId && { turnId }),
        type: 'notice',
        kind: 'answered',
        message: lines.join('\n').slice(0, 2_000),
    };
}

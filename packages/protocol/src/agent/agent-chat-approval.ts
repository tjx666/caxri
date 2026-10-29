import type { AgentChatItem, AgentChatSnapshot } from './agent-chat-contract.js';
import type { AgentChatLabelKey, AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';
import type { AgentChatRequest } from './agent-chat-requests.js';
import { describeAgentTool, isAgentToolActionKind } from './agent-tool-presentation.js';

/**
 * An approval request: everything a provider asks before acting, as opposed to a question it asks the user.
 */
export type AgentChatApprovalRequest = Extract<
    AgentChatRequest,
    { kind: 'command' | 'fileChange' | 'tool' }
>;

export type AgentChatApprovalDecision = 'accept' | 'acceptForSession' | 'acceptAlways' | 'decline';

/**
 * One approval button. `hint` is the longer explanation a Client shows as the button's tooltip, when the label alone
 * does not say what the choice does.
 */
export interface AgentChatApprovalChoice {
    decision: AgentChatApprovalDecision;
    hint?: string;
    label: string;
}

/**
 * Longest command prefix a button label spells out; the tooltip carries the whole prefix.
 */
const ALWAYS_ALLOW_PREFIX_LABEL_LENGTH = 28;

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
 * same. The one-time buttons of an approval whose action is not known beyond "use this tool", such as a Terminal
 * Agent's permission request, read `agentChat.approval.allow` and `agentChat.approval.deny`; a Chat names the outcome
 * instead (`Run`, `Apply Changes`), see {@link agentChatApprovalChoices}.
 */
export function agentApprovalAlwaysAllowLabel(
    scope: 'Chat' | 'Session',
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    return t(
        scope === 'Chat'
            ? 'agentChat.approval.alwaysAllow'
            : 'agentChat.approval.alwaysAllowSession',
    );
}

/**
 * What accepting does, named by the outcome the user gets rather than the protocol verb: a command runs, a file change
 * is applied, plan mode ends, and any other tool (or a command's network access) is allowed.
 */
function acceptLabelKey(request: AgentChatApprovalRequest): AgentChatLabelKey {
    switch (request.kind) {
        case 'command': {
            return request.networkHost ? 'agentChat.approval.allow' : 'agentChat.approval.run';
        }
        case 'fileChange': {
            return 'agentChat.approval.applyChanges';
        }
        case 'tool': {
            return request.name === AGENT_CHAT_EXIT_PLAN_TOOL
                ? 'agentChat.approval.startBuilding'
                : 'agentChat.approval.allow';
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
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): AgentChatApprovalChoice[] {
    const isPlan = request.kind === 'tool' && request.name === AGENT_CHAT_EXIT_PLAN_TOOL;
    const prefix = request.kind === 'command' ? request.alwaysAllowPrefix : undefined;
    const choices: AgentChatApprovalChoice[] = [
        { decision: 'accept', label: t(acceptLabelKey(request)) },
        { decision: 'acceptForSession', label: agentApprovalAlwaysAllowLabel('Chat', t) },
        ...(prefix
            ? [
                  {
                      decision: 'acceptAlways' as const,
                      label: t('agentChat.approval.alwaysAllowPrefix', {
                          prefix:
                              prefix.length > ALWAYS_ALLOW_PREFIX_LABEL_LENGTH
                                  ? `${prefix.slice(0, ALWAYS_ALLOW_PREFIX_LABEL_LENGTH - 1)}…`
                                  : prefix,
                      }),
                      hint: t('agentChat.approval.alwaysAllowPrefixHint', { prefix }),
                  },
              ]
            : []),
        {
            decision: 'decline',
            label: t(isPlan ? 'agentChat.approval.keepPlanning' : 'agentChat.approval.deny'),
        },
    ];
    const allowed = request.decisions && new Set<string>(request.decisions);
    return choices.filter((choice) => !allowed || allowed.has(choice.decision));
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
function agentChatToolRequestTitle(
    request: { name: string; summary?: string },
    t: AgentChatLabelTranslate,
): string {
    const presentation = describeAgentTool(request);
    if (presentation.kind === 'mcp' && presentation.subject)
        return t('agentChat.request.title.mcp', {
            server: presentation.label,
            subject: presentation.subject,
        });
    const { kind, subject } = presentation;
    if (!subject || !isAgentToolActionKind(kind))
        return t('agentChat.request.title.tool', { name: request.name });
    const action = t(`agentChat.request.action.${kind}`);
    return subject.length <= REQUEST_TITLE_SUBJECT_LENGTH && !subject.includes('\n')
        ? t('agentChat.request.title.actionSubject', { action, subject })
        : t('agentChat.request.title.action', { action });
}

/**
 * The approval or question card's heading. `providerName` is the provider catalog's display name, which a question
 * names as the one asking.
 */
export function agentChatRequestTitle(
    request: AgentChatRequest,
    providerName: string,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    switch (request.kind) {
        case 'command': {
            return request.networkHost
                ? t('agentChat.request.title.network', { host: request.networkHost })
                : t('agentChat.request.title.command');
        }
        case 'fileChange': {
            return t('agentChat.request.title.fileChange');
        }
        case 'tool': {
            return request.name === AGENT_CHAT_EXIT_PLAN_TOOL
                ? t('agentChat.request.title.plan')
                : agentChatToolRequestTitle(request, t);
        }
        case 'question': {
            return request.questions.length === 1
                ? t('agentChat.request.title.questionOne', { provider: providerName })
                : t('agentChat.request.title.questionOther', {
                      count: request.questions.length,
                      provider: providerName,
                  });
        }
    }
}

/**
 * What a turn blocked on the user is waiting for: an approval of something the Agent wants to do, or an answer to its
 * question. The first pending request decides, since that is the card the user sees first.
 */
export function agentChatWaitingText(
    requests: readonly AgentChatRequest[],
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const first = requests.at(0);
    return t(
        first && isAgentChatApprovalRequest(first)
            ? 'agentChat.waiting.approval'
            : 'agentChat.waiting.answer',
    );
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
    const asked = request.questions.map((question) => ({
        question,
        answer: (Object.hasOwn(answers, question.id) ? answers[question.id] : []).join(', '),
    }));
    const answered = asked.filter(({ answer }) => answer !== '');
    if (answered.length === 0) return undefined;
    return {
        id: `answer:${request.id}`.slice(0, 200),
        ...(turnId && { turnId }),
        type: 'notice',
        kind: 'answered',
        message: answered
            .map(({ answer, question }) => `${question.header || question.question}: ${answer}`)
            .join('\n')
            .slice(0, 2_000),
        // Every question asked, so `Asked 3 questions` counts what the Agent asked; a skipped one has no answer.
        answers: asked.map(({ answer, question }) => ({
            question: (question.question || question.header).slice(0, 2_000),
            answer: answer.slice(0, 2_000),
        })),
    };
}

/**
 * The fixed message that starts the build once the user approves a proposed plan, as Codex's own TUI sends it.
 */
export const AGENT_CHAT_IMPLEMENT_PLAN_MESSAGE = 'Implement the plan.';

/**
 * The proposed plan a Chat can still be told to build: the latest finished `proposedPlan` reply, while plan mode is on,
 * no turn runs, and nothing the user said came after it. Anything else (a new message, plan mode turned off by hand, a
 * running turn) makes the plan stale. Server Core checks this before acting, and a Client shows its approval card only
 * for the returned item, so the two cannot disagree.
 */
export function agentChatImplementablePlanId(
    snapshot: Pick<AgentChatSnapshot, 'activeTurnId' | 'items' | 'planMode'>,
): string | undefined {
    if (snapshot.planMode !== true || snapshot.activeTurnId) return undefined;
    for (let index = snapshot.items.length - 1; index >= 0; index -= 1) {
        const item = snapshot.items[index];
        if (item.type === 'userMessage') return undefined;
        if (item.type === 'agentMessage' && item.proposedPlan && !item.streaming) return item.id;
    }
    return undefined;
}

/**
 * The approval card a Client shows for an implementable plan, shaped as Claude Code's `ExitPlanMode` request so both
 * Agents share one card, title (`Start with this plan?`), and buttons (`Start Building`, `Keep Planning`). It is never
 * in a snapshot's `requests`: the Client answers it with `agentChat.implementPlan` instead of `agentChat.respond`, and
 * the plan itself is already the reply above it, so the card carries no summary.
 */
export function agentChatProposedPlanRequest(itemId: string): AgentChatRequest {
    return {
        id: `plan:${itemId}`,
        itemId,
        kind: 'tool',
        name: AGENT_CHAT_EXIT_PLAN_TOOL,
        decisions: ['accept', 'decline'],
    };
}

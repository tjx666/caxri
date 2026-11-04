import { coreRouted } from '../../core-routed';
import type { DomainHandlers } from '../../domain-services';
import type { DelegationQuestions } from './service';

export type QuestionMethod =
    | 'agent.delegation.ask'
    | 'agent.delegation.askInternal'
    | 'agent.delegation.askWait'
    | 'agent.delegation.askWaitInternal'
    | 'agent.delegation.askCancel'
    | 'agent.delegation.askCancelInternal'
    | 'agent.delegation.questions'
    | 'agent.delegation.questionsInternal'
    | 'agent.delegation.answer'
    | 'agent.delegation.answerInternal'
    | 'agent.delegation.questionAnswer'
    | 'agent.delegation.questionDetail';

/**
 * The handler map for the questions a delegated Agent asks the Agent that delegated it. The public methods are routed
 * by Server Core to their Internal twins, which carry the caller's authority. The two owner-only methods are enforced
 * from their method specs before they run and take no authority: the user is the owner.
 */
export function createQuestionHandlers(
    questions: DelegationQuestions,
): Pick<DomainHandlers, QuestionMethod> {
    return {
        'agent.delegation.ask': () => coreRouted('agent.delegation.ask'),
        'agent.delegation.askInternal': ({ text, options, requestId, ...authority }) =>
            questions.ask(authority, { text, options, requestId }),
        'agent.delegation.askWait': () => coreRouted('agent.delegation.askWait'),
        'agent.delegation.askWaitInternal': ({ questionId, timeoutMs, ...authority }, signal) =>
            questions.askWait(authority, { questionId, timeoutMs }, signal),
        'agent.delegation.askCancel': () => coreRouted('agent.delegation.askCancel'),
        'agent.delegation.askCancelInternal': ({ questionId, ...authority }) =>
            questions.askCancel(authority, questionId),
        'agent.delegation.questions': () => coreRouted('agent.delegation.questions'),
        'agent.delegation.questionsInternal': ({ delegationId, ...authority }) =>
            questions.list(authority, delegationId),
        'agent.delegation.answer': () => coreRouted('agent.delegation.answer'),
        'agent.delegation.answerInternal': ({ delegationId, questionId, text, ...authority }) =>
            questions.answer(authority, { delegationId, questionId, text }),
        'agent.delegation.questionAnswer': (input) => questions.answerAsUser(input),
        'agent.delegation.questionDetail': ({ delegationId }) => questions.detail(delegationId),
    };
}

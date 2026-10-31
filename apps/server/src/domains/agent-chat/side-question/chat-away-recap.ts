import { AGENT_CHAT_AWAY_RECAP_MAX_LENGTH, CaxriError } from '@caxri/protocol';

import { clipToLength, toPlainLine } from '../../agents';
import type { ChatState, ChatStates } from '../chat-states';
import type { AgentChatServiceOptions } from '../service-options';
import { trackSideQuestion } from './chat-side-question';
import { EmptySideAnswerError } from './side-answer-error';

/**
 * The side question behind an away recap. It travels only in a tool-less side request (Claude Code's side question, an
 * ephemeral Codex fork), so the conversation never sees it and the Agent's behavior is unchanged. Caxri's own wording;
 * the shape (goal and state first, then the next step, no diagnosis narrative) follows Claude Code's recap.
 */
const AWAY_RECAP_PROMPT =
    'The user stepped away while you worked and is about to come back. Recap this conversation for them in one or two ' +
    'plain sentences, under 50 words, with no Markdown, headings, or lists, in the language the user writes in. Say ' +
    'what the overall task is and where it stands now, then the single next step, naming anything the user must ' +
    'decide or do. Leave out how problems were diagnosed, implementation details, and minor follow-ups.';

/**
 * Why a recap was not generated, for the log: `changed` when a reply or turn arrived first, `notRunning` when the
 * provider stopped, `usageGuard` at the weekly usage guard, else the side question's own failure.
 */
type AwayRecapFailure =
    'changed' | 'notRunning' | 'usageGuard' | 'timeout' | 'empty' | 'providerError';

const NOT_RUNNING = 'The Chat is not running';

export function awayRecapFailureReason(error: unknown): AwayRecapFailure {
    if (error instanceof EmptySideAnswerError) return 'empty';
    if (!(error instanceof CaxriError)) return 'providerError';
    if (error.code === 'CONFLICT') return 'changed';
    if (error.code === 'TIMEOUT') return 'timeout';
    if (error.code === 'USAGE_LIMITED') return 'usageGuard';
    return error.code === 'UNAVAILABLE' && error.message === NOT_RUNNING
        ? 'notRunning'
        : 'providerError';
}

/**
 * The recap as one plain line: a card and an Activity row render text, so stray Markdown would show as punctuation.
 */
function toAwayRecapText(answer: string): string {
    return clipToLength(toPlainLine(answer), AGENT_CHAT_AWAY_RECAP_MAX_LENGTH);
}

/**
 * Asks the Chat's running provider for a recap of the reply at `lastResponseAt` and stores it on the projection
 * (`awayRecap`), which carries it to every Client. It never starts a provider. A reply or turn that arrives while the
 * recap is generated makes it describe an older state, so it is dropped with `CONFLICT` instead of stored.
 */
export async function generateChatAwayRecap(
    options: Pick<AgentChatServiceOptions, 'usage'>,
    states: Pick<ChatStates, 'apply'>,
    terminalId: string,
    state: ChatState | undefined,
    lastResponseAt: number,
    now: () => number = Date.now,
): Promise<string> {
    const session = state?.session;
    if (!state || !session?.isOpen || !session.askSideQuestion)
        throw new CaxriError('UNAVAILABLE', NOT_RUNNING);
    options.usage?.assert(terminalId, 'away_recap');
    const isCurrent = () => {
        const { activeTurnId, usage } = state.projection.snapshot;
        return activeTurnId === undefined && usage?.lastResponseAt === lastResponseAt;
    };
    if (!isCurrent()) throw new CaxriError('CONFLICT', 'The Chat changed before its recap');
    const answer = await trackSideQuestion(state, () =>
        session.askSideQuestion!(AWAY_RECAP_PROMPT, []),
    );
    if (!isCurrent()) throw new CaxriError('CONFLICT', 'The Chat changed during its recap');
    const text = toAwayRecapText(answer);
    if (!text) throw new EmptySideAnswerError('recap');
    states.apply(terminalId, [
        { op: 'state', state: { awayRecap: { text, lastResponseAt, generatedAt: now() } } },
    ]);
    return text;
}

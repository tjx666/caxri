import { createHash } from 'node:crypto';

import { CaxriError } from '@caxri/protocol';
import { coerce, gte } from 'semver';

import type { AgentEnvironment } from '../../contract';
import type {
    AgentDelegationAdapter,
    DelegationCompletion,
    DelegationEvidence,
} from '../../delegation-contract';
import { replaceDelegationArguments, validateDelegationArguments } from '../../delegation-contract';
import { readAntigravityConversation } from './conversation-database';
import { antigravityConversationPath } from './paths';

const valueFlags = new Set(['--model', '--effort', '--mode', '--add-dir']);
const booleanFlags = new Set(['--dangerously-skip-permissions', '--sandbox']);

interface ConversationLine {
    role: 'user' | 'assistant';
    text: string;
}

function digest(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * Serializes the conversation's visible messages as JSON lines, the content shape every delegation extractor reads. The
 * database holds no turn-end record, so this read is only meaningful after the authenticated `Stop` hook proved the
 * turn ended; {@link antigravityDelegationAdapter} declares that with `completionAwaitsStop`.
 */
function readAntigravityDelegationTranscript(
    sessionId: string,
    environment: AgentEnvironment,
): Promise<string | undefined> {
    const conversation = readAntigravityConversation(
        antigravityConversationPath(environment, sessionId),
    );
    return Promise.resolve(
        conversation?.messages
            .map((message) => `${JSON.stringify(message satisfies ConversationLine)}\n`)
            .join(''),
    );
}

/**
 * The task's answer is the last visible reply after the user message whose digest matches the submitted task pointer.
 * `agy` writes a reply before every tool call too, so only the last one before the next user message is final, and only
 * once `Stop` ended the turn. The pointer's latest occurrence wins, since a resumed conversation can hold it twice.
 */
export function extractAntigravityDelegationCompletion(
    content: string,
    evidence: DelegationEvidence,
): DelegationCompletion | undefined {
    if (!evidence.turnId) return;
    const lines: ConversationLine[] = [];
    for (const line of content.split('\n')) {
        try {
            const parsed = JSON.parse(line) as Partial<ConversationLine> | null;
            if (
                (parsed?.role === 'user' || parsed?.role === 'assistant') &&
                typeof parsed.text === 'string'
            )
                lines.push({ role: parsed.role, text: parsed.text });
        } catch {
            // Blank trailing line.
        }
    }
    const prompt = lines.findLastIndex(
        (line) => line.role === 'user' && digest(line.text) === evidence.promptDigest,
    );
    if (prompt === -1) return;
    const reply = lines.slice(prompt + 1);
    let answer: string | undefined;
    for (const line of reply) {
        if (line.role === 'user') break;
        answer = line.text;
    }
    return answer ? { kind: 'answer', text: answer, messageId: evidence.turnId } : undefined;
}

export const antigravityDelegationAdapter: AgentDelegationAdapter = {
    completion: 'native-completion',
    completionAwaitsStop: true,
    /**
     * `agy` chooses the conversation id itself; the first `PreInvocation` hook binds it.
     */
    createSessionId: () => {},
    validateLaunch: (launch) => validateDelegationArguments(launch, valueFlags, booleanFlags),
    selectLaunch: (launch, selection) =>
        replaceDelegationArguments(launch, new Set(['--model', '--effort']), [
            ...(selection.model ? ['--model', selection.model] : []),
            ...(selection.effort ? ['--effort', selection.effort] : []),
        ]),
    verifyVersion: (source) => {
        const version = coerce(source ?? '');
        if (version?.major !== 1 || !gte(version, '1.4.11'))
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires Antigravity CLI 1.4.11+ within major 1',
            );
    },
    readTranscript: readAntigravityDelegationTranscript,
    extractCompletion: extractAntigravityDelegationCompletion,
};

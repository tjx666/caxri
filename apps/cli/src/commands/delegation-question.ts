import {
    CaxriError,
    delegationQuestionAnswerParametersSchema,
    delegationQuestionAskParametersSchema,
    MAX_ANSWER_TEXT_CHARS,
    MAX_QUESTION_OPTION_CHARS,
    MAX_QUESTION_OPTIONS,
    MAX_QUESTION_TEXT_CHARS,
} from '@caxri/protocol';

import { readBoundedTextFile } from './text-file';
import type { RemoteCommandDefinition } from './types';

/**
 * A character is at most four UTF-8 bytes, so the file read is bounded by bytes and the schema then bounds characters.
 */
const MAX_UTF8_BYTES_PER_CHAR = 4;

function identifierArgument(token: string | undefined, label: string): string {
    if (!token || token.startsWith('-'))
        throw new CaxriError('VALIDATION', `Expected one ${label}`);
    return token;
}

function messageText(
    tokens: readonly string[],
    maxChars: number,
    label: string,
): Promise<string> | string {
    const text: string[] = [];
    const files: string[] = [];
    for (let index = 0; index < tokens.length; index += 2) {
        const flag = tokens[index];
        if (index + 1 >= tokens.length || (flag !== '--text' && flag !== '--file'))
            throw new CaxriError('VALIDATION', 'Expected --text <text> or --file <path>');
        const value = tokens[index + 1];
        (flag === '--text' ? text : files).push(value);
    }
    if (text.length + files.length !== 1)
        throw new CaxriError('VALIDATION', `Pass exactly one of --text or --file for the ${label}`);
    return files.length === 1
        ? readBoundedTextFile(files[0], maxChars * MAX_UTF8_BYTES_PER_CHAR, label)
        : text[0];
}

async function askParameters(tokens: readonly string[]) {
    const options: string[] = [];
    const rest: string[] = [];
    let requestId: string | undefined;
    for (let index = 0; index < tokens.length; index += 2) {
        const flag = tokens[index];
        if (index + 1 >= tokens.length)
            throw new CaxriError('VALIDATION', `${flag} requires a value`);
        const value = tokens[index + 1];
        if (flag === '--option') options.push(value.trim());
        else if (flag === '--request-id') {
            if (requestId !== undefined)
                throw new CaxriError('VALIDATION', 'Pass --request-id at most once');
            requestId = value;
        } else rest.push(flag, value);
    }
    if (options.length > MAX_QUESTION_OPTIONS)
        throw new CaxriError('VALIDATION', `Pass at most ${MAX_QUESTION_OPTIONS} --option values`);
    if (options.some((option) => option.length === 0 || option.length > MAX_QUESTION_OPTION_CHARS))
        throw new CaxriError(
            'VALIDATION',
            `Each --option must be 1-${MAX_QUESTION_OPTION_CHARS} characters`,
        );
    if (new Set(options).size !== options.length)
        throw new CaxriError('VALIDATION', 'Each --option must be different');
    const text = await messageText(rest, MAX_QUESTION_TEXT_CHARS, 'Question');
    return delegationQuestionAskParametersSchema.parse({
        text,
        ...(options.length > 0 && { options }),
        ...(requestId !== undefined && { requestId }),
    });
}

function questionIdentity(tokens: readonly string[]) {
    if (tokens.length !== 1) throw new CaxriError('VALIDATION', 'Expected one question ID');
    return { questionId: identifierArgument(tokens[0], 'question ID') };
}

function questionsParameters(tokens: readonly string[]) {
    if (tokens.length > 1) throw new CaxriError('VALIDATION', 'Expected at most one delegation ID');
    return tokens.length === 0
        ? {}
        : { delegationId: identifierArgument(tokens[0], 'delegation ID') };
}

async function answerParameters(tokens: readonly string[]) {
    const [delegationId, questionId, ...rest] = tokens;
    const checkedDelegationId = identifierArgument(delegationId, 'delegation ID');
    const checkedQuestionId = identifierArgument(questionId, 'question ID');
    const text = await messageText(rest, MAX_ANSWER_TEXT_CHARS, 'Answer');
    return delegationQuestionAnswerParametersSchema.parse({
        delegationId: checkedDelegationId,
        questionId: checkedQuestionId,
        text,
    });
}

/**
 * Commands of the question exchange between a delegated Agent and the Agent that delegated to it. They are flat (`ask`,
 * not `question ask`) because the catalog resolves by prefix and a longer path would be swallowed by it. The question
 * and answer text travels only in the request and reply; the CLI never logs it.
 */
export const DELEGATION_QUESTION_COMMANDS: RemoteCommandDefinition[] = [
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'ask'],
        method: 'agent.delegation.ask',
        summary:
            'From a delegated task, ask the Agent that delegated it one question and keep working.',
        usage: '(--text <text> | --file <path>) [--option <choice>...] [--request-id <id>]',
        parseParams: askParameters,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'ask-wait'],
        method: 'agent.delegation.askWait',
        summary:
            'Wait for the answer to your question; a timeout means it is still open, never ask it again.',
        usage: '<question-id> [--timeout <milliseconds>]',
        parseParams: questionIdentity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'ask-cancel'],
        method: 'agent.delegation.askCancel',
        summary: 'Withdraw your open question.',
        usage: '<question-id>',
        parseParams: questionIdentity,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'questions'],
        method: 'agent.delegation.questions',
        summary: 'List the open questions your delegated tasks are waiting on.',
        usage: '[<delegation-id>]',
        parseParams: questionsParameters,
    },
    {
        kind: 'remote',
        path: ['agent', 'delegate', 'answer'],
        method: 'agent.delegation.answer',
        summary: 'Answer the open question of one of your delegated tasks.',
        usage: '<delegation-id> <question-id> (--text <text> | --file <path>)',
        parseParams: answerParameters,
    },
];

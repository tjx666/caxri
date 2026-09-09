import { createHash, randomUUID } from 'node:crypto';

import type { AgentDelegationUsage } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { coerce, gte } from 'semver';

import type { AgentDelegationAdapter } from '../../delegation-contract';
import { replaceDelegationArguments, validateDelegationArguments } from '../../delegation-contract';
import { collectClaudeUsage, totalClaudeUsage } from './delegation-usage';

const valueFlags = new Set([
    '--model',
    '--effort',
    '--permission-mode',
    '--agent',
    '--name',
    '--tools',
]);
const booleanFlags = new Set([
    '--verbose',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--dangerously-skip-permissions',
]);

export const claudeDelegationAdapter: AgentDelegationAdapter = {
    completion: 'stop-digest',
    createSessionId: randomUUID,
    validateLaunch: (launch) => validateDelegationArguments(launch, valueFlags, booleanFlags),
    selectLaunch: (launch, selection) =>
        replaceDelegationArguments(launch, new Set(['--model', '--effort']), [
            ...(selection.model ? ['--model', selection.model] : []),
            ...(selection.effort ? ['--effort', selection.effort] : []),
        ]),
    verifyVersion: (source) => {
        const version = coerce(source ?? '');
        if (version?.major !== 2 || !gte(version, '2.1.196'))
            throw new CaxriError(
                'UNAVAILABLE',
                'Visible delegation requires Claude Code 2.1.196+ within major 2',
            );
    },
    freshLaunch: (launch, pointer, directory, sessionId) => {
        if (!sessionId || !/^[\da-f-]{36}$/u.test(sessionId))
            throw new CaxriError(
                'VALIDATION',
                'Delegation launch requires a generated session identifier',
            );
        return {
            ...launch,
            args: [
                ...launch.args,
                '--session-id',
                sessionId,
                '--add-dir',
                directory,
                '--',
                pointer,
            ],
        };
    },
    resumeLaunch: (launch, directory) => ({
        ...launch,
        args: [...launch.args, '--add-dir', directory],
    }),
    extractCompletion: (content, evidence) => {
        if (!evidence.answerDigest) return;
        const answer = extractClaudeDelegationAnswer(content, {
            ...evidence,
            answerDigest: evidence.answerDigest,
        });
        return answer ? { kind: 'answer', ...answer } : undefined;
    },
};

export interface ClaudeDelegationAnswer {
    text: string;
    messageId: string;
    usage?: AgentDelegationUsage;
}

export interface ClaudeDelegationEvidence {
    sessionId: string;
    promptDigest: string;
    answerDigest: string;
    continuationPromptDigests?: readonly string[];
}

function digest(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

function textVariants(content: unknown): string[] {
    if (typeof content === 'string') return [content];
    if (!Array.isArray(content)) return [];
    const blocks: string[] = [];
    for (const item of content as unknown[]) {
        if (!item || typeof item !== 'object') return [];
        const block = item as Record<string, unknown>;
        if (block.type === 'text' && typeof block.text === 'string') blocks.push(block.text);
    }
    return blocks.length > 0
        ? [...new Set(['', '\n', '\n\n'].map((separator) => blocks.join(separator)))]
        : [];
}

function isHumanContent(content: unknown): boolean {
    if (typeof content === 'string') return true;
    return (
        Array.isArray(content) &&
        content.some(
            (block: unknown) =>
                !block ||
                typeof block !== 'object' ||
                (block as Record<string, unknown>).type !== 'tool_result',
        )
    );
}

/**
 * Matches only an exact submitted prompt and a final-answer digest supplied by its authenticated Stop hook. A
 * transcript can lag Stop or contain intermediate assistant messages: neither file EOF nor the latest message proves
 * completion. The caller must additionally fence the hook's prompt id, session, and launch generation.
 *
 * @see https://code.claude.com/docs/en/hooks#common-input-fields
 */
export function extractClaudeDelegationAnswer(
    appendedTranscript: string,
    evidence: ClaudeDelegationEvidence,
): ClaudeDelegationAnswer | undefined {
    let promptId: string | undefined;
    let continuationIndex = 0;
    const continuationDigests = evidence.continuationPromptDigests ?? [];
    const descendants = new Set<string>();
    const messageVariants = new Map<string, string[]>();
    const usages = new Map<string, AgentDelegationUsage | undefined | null>();
    let hasMalformedUsageEvidence = false;
    let matched: ClaudeDelegationAnswer | undefined;
    const finish = () => {
        if (!matched) return;
        const usage = hasMalformedUsageEvidence ? undefined : totalClaudeUsage(usages);
        return usage ? { ...matched, usage } : matched;
    };
    for (const line of appendedTranscript.split('\n')) {
        let record: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            record = parsed as Record<string, unknown>;
        } catch {
            if (promptId !== undefined && line.trim()) hasMalformedUsageEvidence = true;
            continue;
        }
        if (record.sessionId !== evidence.sessionId || record.isSidechain === true) continue;
        if (typeof record.uuid !== 'string') continue;
        const message = record.message;
        const content =
            message && typeof message === 'object' && !Array.isArray(message)
                ? (message as Record<string, unknown>).content
                : undefined;
        const variants = textVariants(content);
        if (record.type === 'user' && record.isMeta !== true && isHumanContent(content)) {
            if (promptId !== undefined) {
                // Only an ordered, coordinator-proven native continuation can extend this task's ancestry.
                if (
                    typeof record.parentUuid !== 'string' ||
                    !descendants.has(record.parentUuid) ||
                    variants.every(
                        (text) => digest(text) !== continuationDigests[continuationIndex],
                    )
                )
                    return finish();
                continuationIndex++;
                descendants.add(record.uuid);
                continue;
            }
            if (variants.every((text) => digest(text) !== evidence.promptDigest)) continue;
            promptId = record.uuid;
            descendants.add(promptId);
            continue;
        }
        if (
            promptId === undefined ||
            typeof record.parentUuid !== 'string' ||
            !descendants.has(record.parentUuid)
        )
            continue;
        descendants.add(record.uuid);
        if (record.type !== 'assistant') continue;
        const messageId = (message as Record<string, unknown> | undefined)?.id;
        /**
         * The authenticated answer closes the set of API calls owned by this task. Later streaming snapshots may finish
         * those calls' counters, but a new API message after that answer belongs to unproven subsequent work.
         */
        if (!matched || (typeof messageId === 'string' && usages.has(messageId)))
            collectClaudeUsage(usages, message as Record<string, unknown> | undefined, record.uuid);
        const previous = typeof messageId === 'string' ? messageVariants.get(messageId) : undefined;
        const candidates = previous
            ? [
                  ...variants,
                  ...previous.flatMap((prefix) =>
                      variants.flatMap((text) =>
                          ['', '\n', '\n\n'].map((separator) => prefix + separator + text),
                      ),
                  ),
              ]
            : variants;
        // Cap combinatorics on malformed or repeated streaming blocks; missing evidence fails closed.
        if (typeof messageId === 'string' && candidates.length <= 81)
            messageVariants.set(messageId, candidates);
        const answer = candidates.find((text) => digest(text) === evidence.answerDigest);
        if (answer !== undefined && continuationIndex === continuationDigests.length)
            matched ??= { text: answer, messageId: record.uuid };
    }
    return finish();
}

import { createHash } from 'node:crypto';

export interface ClaudeDelegationAnswer {
    text: string;
    messageId: string;
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
    for (const line of appendedTranscript.split('\n')) {
        let record: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            record = parsed as Record<string, unknown>;
        } catch {
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
                    return;
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
            return { text: answer, messageId: record.uuid };
    }
    return;
}

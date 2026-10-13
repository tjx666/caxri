import type { AgentTranscript } from '@caxri/protocol';

import type { DelegationTranscriptBatch } from '../agents';
/**
 * Provider transcript extraction stays behind the agents domain's public API.
 */
// react-doctor-disable-next-line react-doctor/no-barrel-import
import { delegationAdapter } from '../agents';
import type { StoredAgentDelegation } from '../db';
import type { DelegationChatTurn } from './chat-child';
import { chatDelegationCompletion } from './chat-child';

export interface DelegationTranscriptReader {
    readTranscript(terminalId: string): Promise<AgentTranscript | null>;
    /**
     * The task's turn in a Chat child's projection, or `undefined` for a PTY Terminal, whose transcript is read
     * instead.
     */
    readChatTurn?(terminalId: string, turnId: string): DelegationChatTurn | undefined;
    readNativeTranscript?(
        terminalId: string,
        sessionId: string,
        offset: number | undefined,
        turnId: string | undefined,
    ): Promise<DelegationTranscriptBatch>;
}

/**
 * The caller must recheck the durable revision after these reads before applying completion or usage.
 */
export async function readDelegationCompletion(
    record: StoredAgentDelegation,
    reader: DelegationTranscriptReader,
) {
    const adapter = delegationAdapter(record.receipt.provider);
    const terminalId = record.receipt.terminalId!;
    const chatTurn = record.turnId ? reader.readChatTurn?.(terminalId, record.turnId) : undefined;
    if (chatTurn)
        return { completion: chatDelegationCompletion(record, chatTurn), batch: undefined };
    const sessionId = record.providerSessionId!;
    const evidence = {
        sessionId,
        promptDigest: record.promptDigest,
        answerDigest: record.responseDigest,
        answerByteLength: record.responseByteLength,
        answerStopCount: record.responseStopCount,
        answerOverflow: record.responseOverflow,
        turnId: record.turnId,
        continuationPromptDigests: record.continuationPromptDigests,
    };
    const isNative = adapter.completion === 'native-completion';
    const batch = isNative
        ? await reader.readNativeTranscript?.(
              terminalId,
              sessionId,
              record.transcriptOffset,
              record.turnId,
          )
        : undefined;
    const transcript = isNative ? undefined : await reader.readTranscript(terminalId);
    const content = batch?.content ?? transcript?.content;
    let completion = batch?.failure
        ? { kind: 'failed' as const, failure: batch.failure }
        : content
          ? adapter.extractCompletion(content, evidence)
          : undefined;
    if (completion && !batch?.failure && adapter.completionRequiresTranscript) {
        const full = await reader.readTranscript(terminalId);
        completion = full?.content ? adapter.extractCompletion(full.content, evidence) : completion;
    }
    if (
        completion &&
        adapter.extractUsage &&
        (completion.kind === 'answer' || completion.failure !== 'correlation_missing')
    ) {
        // Incremental completion reads omit earlier cumulative counters. Read one bounded window only after finality.
        try {
            const full = await reader.readTranscript(terminalId);
            const usage = full?.content ? adapter.extractUsage(full.content, evidence) : undefined;
            if (usage) completion = { ...completion, usage };
        } catch {
            // Optional accounting cannot discard an already proven answer when its extra evidence read fails.
        }
    }
    return { completion, batch };
}

import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { CaxriError } from '@caxri/protocol';

import { clip } from './chat-items';
import type { AgentChatTranscript, ChatResumePoint, ChatRewindTarget } from './chat-provider';
import { claudeRewindPoint } from './claude-history';

/**
 * Claude Code rewinds a conversation only by resuming it at an earlier record (`resumeSessionAt`), so this finds that
 * point in the transcript and leaves the resume to the restart that follows. Files go back first through the SDK's file
 * checkpoints: a dry run proves a checkpoint exists for the message (a turn that ran before checkpointing was enabled
 * has none) before anything on disk changes.
 */
export async function rewindClaudeSession(
    query: Query,
    transcript: AgentChatTranscript | undefined,
    target: ChatRewindTarget,
): Promise<ChatResumePoint> {
    const point = transcript && claudeRewindPoint(transcript.content, target.itemId);
    if (!point)
        throw new CaxriError(
            'CONFLICT',
            "This message is older than the part of Claude's record Caxri reads",
        );
    if (!target.restoreFiles) return point;
    const preview = await query.rewindFiles(target.itemId, { dryRun: true });
    if (!preview.canRewind)
        throw new CaxriError(
            'CONFLICT',
            clip(
                `Claude cannot restore files for this message: ${preview.error ?? 'no checkpoint'}`,
                300,
            ),
        );
    const applied = await query.rewindFiles(target.itemId);
    if (!applied.canRewind)
        throw new CaxriError(
            'UNAVAILABLE',
            clip(`Claude could not restore files: ${applied.error ?? 'unknown error'}`, 300),
        );
    return point;
}

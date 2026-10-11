/**
 * The fake Grok ACP agent's `_x.ai/rewind/points` and `_x.ai/rewind/execute`, which "Edit from here" uses to drop the
 * prompts after an earlier message.
 */
import fs from 'node:fs';
import path from 'node:path';

type Json = Record<string, unknown>;

interface RewindFrame {
    update: Json;
}

interface RewindSession {
    id: string;
    frames: RewindFrame[];
}

interface RewindTarget {
    isPromptRunning: boolean;
    stateDirectory: string;
    /**
     * Persists the session after its frames were cut.
     */
    save: () => void;
}

/**
 * Indexes of the frames that start a prompt, in order; a prompt's position in this list is its `prompt_index`.
 */
function promptFrameIndexes(frames: readonly RewindFrame[]): number[] {
    return frames.flatMap((frame, index) =>
        frame.update.sessionUpdate === 'user_message_chunk' ? [index] : [],
    );
}

function promptText(frame: RewindFrame | undefined): string {
    const content = frame?.update.content as { text?: unknown } | undefined;
    return typeof content?.text === 'string' ? content.text : '';
}

/**
 * Lists one rewind point per prompt with a truncated preview, like Grok Build's `_x.ai/rewind/points`.
 */
export function rewindPoints(frames: readonly RewindFrame[]): Json {
    return {
        rewind_points: promptFrameIndexes(frames).map((frameIndex, promptIndex) => {
            const text = promptText(frames[frameIndex]);
            return {
                prompt_index: promptIndex,
                created_at: new Date().toISOString(),
                num_file_snapshots: 0,
                has_file_changes: false,
                prompt_preview: text.length > 20 ? `${text.slice(0, 20)}…` : text,
            };
        }),
    };
}

/**
 * Drops the target prompt and everything after it, then logs the call to `rewinds.jsonl` so tests can check the mode. A
 * real Grok Build appends a rewind marker instead; either way a later `session/load` replays the shorter history.
 */
export function rewindExecute(
    session: RewindSession,
    parameters: Json,
    { isPromptRunning, stateDirectory, save }: RewindTarget,
): Json {
    const targetPromptIndex = Number(parameters.targetPromptIndex);
    const frameIndex = promptFrameIndexes(session.frames).at(targetPromptIndex);
    if (frameIndex === undefined || isPromptRunning)
        return { success: false, error: `Cannot rewind to prompt ${targetPromptIndex}` };
    const promptTextAtTarget = promptText(session.frames[frameIndex]);
    if (parameters.force === true) {
        session.frames = session.frames.slice(0, frameIndex);
        save();
        fs.appendFileSync(
            path.join(stateDirectory, 'rewinds.jsonl'),
            `${JSON.stringify({ sessionId: session.id, targetPromptIndex, mode: parameters.mode })}\n`,
        );
    }
    return { success: true, prompt_text: promptTextAtTarget };
}

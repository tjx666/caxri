/**
 * "Edit from here" support for the fake Claude Code CLI (`fake-claude-cli.ts`): resuming at an earlier record and
 * answering `rewind_files`.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

type Json = Record<string, unknown>;

/**
 * Where a resumed chain continues, the way the CLI does: from `--resume-session-at` when given, else from the newest
 * record of `transcriptPath`.
 */
export function resumedLeaf(transcriptPath: string, resumeAt: string | undefined): string | null {
    if (resumeAt) return resumeAt;
    const records = fs
        .readFileSync(transcriptPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Json);
    const last = records.findLast((entry) => typeof entry.uuid === 'string');
    return (last?.uuid as string | undefined) ?? null;
}

/**
 * Answers `rewind_files` for a prompt this session recorded and logs each call to `rewinds.jsonl` in the config
 * directory, so tests can check what Caxri asked to restore. The real CLI refuses unless the SDK enabled file
 * checkpointing.
 */
export function rewindFiles(
    request: Json,
    transcriptPath: string,
    configDirectory: string,
): { response?: Json; error?: string } {
    if (process.env.CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING !== 'true')
        return { error: 'File rewinding is not enabled for this session.' };
    const id = String(request.user_message_id);
    const isKnown = fs
        .readFileSync(transcriptPath, 'utf8')
        .split('\n')
        .some((line) => line.includes(`"uuid":"${id}"`));
    if (!isKnown)
        return { response: { canRewind: false, error: `No file checkpoint found for ${id}` } };
    fs.appendFileSync(
        path.join(configDirectory, 'rewinds.jsonl'),
        `${JSON.stringify({ userMessageId: id, dryRun: request.dry_run === true })}\n`,
    );
    return {
        response: {
            canRewind: true,
            filesChanged: ['notes.md', path.join(process.cwd(), 'src/app.ts')],
            insertions: 4,
            deletions: 1,
        },
    };
}

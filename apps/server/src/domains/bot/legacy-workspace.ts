import { rename } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The workspace's name from when the feature was called Agent Commander. The single-baseline rebuild wipes the Bot
 * Project and its conversation, which were the only reasons to keep that name, but the directory still holds the user's
 * `memory/` notes, so the workspace is moved to its new name instead of starting an empty one.
 */
const LEGACY_BOT_WORKSPACE_DIRECTORY = 'agent-commander';

/**
 * Moves a workspace left at the legacy name to `workspacePath`. Does nothing when there is no legacy workspace or the
 * new one already exists, so it is safe on every `bot.ensure`.
 */
export async function carryLegacyBotWorkspace(
    userDataPath: string,
    workspacePath: string,
): Promise<void> {
    try {
        await rename(join(userDataPath, LEGACY_BOT_WORKSPACE_DIRECTORY), workspacePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
    }
}

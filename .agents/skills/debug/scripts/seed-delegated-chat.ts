/**
 * Seeds delegated child Sessions under a dev profile's Chat, so the composer's Delegated Sessions strip can be
 * inspected in a dev instance. Only a Server-side Agent can create a delegated Session, so the rows come from the same
 * seeds the E2E specs use (`e2e/support/server-database/delegated-chat-seed.ts`): its `children` phase (a failed, an
 * unreadable, a not-yet-recorded and a consult child), its `deep` phase (a completed child with a failed grandchild),
 * and its `attention` phase (a child with an unread finished result and one with an unread question, for the sidebar's
 * nested status glyphs).
 *
 * The app must not be running on the profile: `open-chat` first, `switch-worktree stop`, run this, then start `dev`
 * again on the same profile.
 *
 * Usage: `bun run .agents/skills/debug/scripts/seed-delegated-chat.ts --user-data-dir <absolute path> [--session <id>]`
 * Without `--session`, the host is the newest top-level Session that has an Agent.
 */
import { isAbsolute } from 'node:path';
import process from 'node:process';

import { runServerDatabase } from '../../../../e2e/support/run-server-database';
import type { ChatHost } from '../../../../e2e/support/server-database/chat-host';
import type {
    AttentionDelegatedChatSeed,
    DeepDelegatedChatSeed,
    DelegatedChatSeed,
} from '../../../../e2e/support/server-database/delegated-chat-seed';
import { CommandError } from '../../switch-worktree/scripts/process';

export interface SeedArguments {
    userData: string;
    sessionId?: string;
}

export function parseSeedArguments(argv: string[]): SeedArguments {
    let userData: string | undefined;
    let sessionId: string | undefined;
    for (let index = 0; index < argv.length; index++) {
        const flag = argv[index];
        const value = argv.at(++index);
        if (value === undefined) throw new CommandError(`${flag} needs a value`, 2);
        if (flag === '--user-data-dir') userData = value;
        else if (flag === '--session') sessionId = value;
        else throw new CommandError(`Unknown argument ${flag}`, 2);
    }
    if (userData === undefined || !isAbsolute(userData)) {
        throw new CommandError(
            'Pass --user-data-dir <absolute path> of the stopped dev profile',
            2,
        );
    }
    return { userData, ...(sessionId !== undefined && { sessionId }) };
}

async function main(): Promise<void> {
    const { userData, sessionId } = parseSeedArguments(process.argv.slice(2));
    const host = await runServerDatabase<ChatHost>('chat-host', {
        userData,
        ...(sessionId !== undefined && { sessionId }),
    });
    const input = { userData, hostSessionId: host.sessionId, projectId: host.projectId };
    const children = await runServerDatabase<DelegatedChatSeed>('delegated-chat-seed', {
        ...input,
        phase: 'children',
    });
    const deep = await runServerDatabase<DeepDelegatedChatSeed>('delegated-chat-seed', {
        ...input,
        phase: 'deep',
    });
    const attention = await runServerDatabase<AttentionDelegatedChatSeed>('delegated-chat-seed', {
        ...input,
        phase: 'attention',
    });
    process.stdout.write(`${JSON.stringify({ host, children, deep, attention }, null, 2)}\n`);
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = error instanceof CommandError ? error.exitCode : 1;
    }
}

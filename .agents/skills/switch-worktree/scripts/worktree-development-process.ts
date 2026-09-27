import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CommandError } from './process';
import type { RepoContext } from './repo';
import { errorCode } from './repo';

/**
 * Durable record of one `switch-worktree dev` launch, keyed by the worktree's stable identity (see `worktreeIdentity`
 * in `repo.ts`). Split out of `worktree.ts` — which sits at the repository's `max-lines` cap — because `stopWorktree`,
 * `inspectOne`, `removeWorktree`, and `developmentWorktree` all read and write it.
 */
export interface DevelopmentProcessRecord {
    cdpPort: number;
    identity: string;
    pid: number;
    startedAt: string;
    token: string;
    worktreeId: string;
    worktreePath: string;
}

export function developmentProcessPath(context: RepoContext, identity: string): string {
    return join(context.stateDir, 'processes', `${identity}.json`);
}

/**
 * A record failing this shape check is never a compatible-but-older format to migrate — see AGENTS.md's pre-release
 * no-compatibility-layer policy — it is either corrupt or a stale record from before a required field such as `cdpPort`
 * existed, and callers should fail clearly on it.
 */
export async function readDevelopmentProcess(
    context: RepoContext,
    identity: string | undefined,
): Promise<DevelopmentProcessRecord | undefined> {
    if (!identity) return undefined;
    try {
        const candidate = JSON.parse(
            await readFile(developmentProcessPath(context, identity), 'utf8'),
        ) as Partial<DevelopmentProcessRecord>;
        if (
            typeof candidate.identity !== 'string' ||
            typeof candidate.pid !== 'number' ||
            !Number.isSafeInteger(candidate.pid) ||
            candidate.pid <= 0 ||
            typeof candidate.startedAt !== 'string' ||
            typeof candidate.token !== 'string' ||
            candidate.worktreeId !== identity ||
            typeof candidate.worktreePath !== 'string' ||
            typeof candidate.cdpPort !== 'number' ||
            !Number.isSafeInteger(candidate.cdpPort) ||
            candidate.cdpPort <= 0
        ) {
            throw new Error('invalid process record');
        }
        return candidate as DevelopmentProcessRecord;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw new CommandError(
            `Invalid dev process record for worktree ${identity}; inspect it before continuing`,
        );
    }
}

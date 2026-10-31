import { stat } from 'node:fs/promises';

import type { ServerOperationParameters } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { ProjectRootResolver } from '../project';

/**
 * Returns the first candidate that is a regular file the Session may reach, spending one unit of `budget` per probe.
 * Probes run in order and sequentially: the first existing candidate wins, and a parallel probe would do the filesystem
 * work of every fallback for every hit. See `FileService.resolveImports`.
 */
export async function resolveImportSpecifier(
    projectRoots: ProjectRootResolver,
    parameters: ServerOperationParameters<'files.resolveImports'>,
    candidates: string[],
    budget: { remaining: number },
): Promise<string | undefined> {
    for (const candidate of candidates) {
        if (budget.remaining-- <= 0) return undefined;
        try {
            // eslint-disable-next-line no-await-in-loop -- first existing candidate wins, see above
            const resolved = await projectRoots.resolveSessionPath(
                parameters.sessionId,
                candidate,
                true,
            );
            // eslint-disable-next-line no-await-in-loop -- first existing candidate wins, see above
            if ((await stat(resolved.path)).isFile())
                return resolved.workspacePath ?? resolved.path;
        } catch (error) {
            /**
             * A missing candidate is the expected answer for every extension the target does not use, so the loop moves
             * on. Anything else (notably a path the Session is not allowed to reach) stops this specifier instead of
             * falling through to the next guess, which would turn one refusal into a probe sequence.
             */
            if (error instanceof CaxriError && error.code === 'NOT_FOUND') continue;
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            return undefined;
        }
    }
    return undefined;
}

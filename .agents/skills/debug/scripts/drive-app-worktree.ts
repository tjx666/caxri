import { realpath } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { CommandError } from '../../switch-worktree/scripts/process';
import { request } from './drive-app-settings';

/**
 * One row of `session.workbenchRoots`, reduced to what `enter-worktree` reads.
 */
export interface WorkbenchRootChoice {
    authorization: 'authorized' | 'required';
    projectId?: string;
    rootPath: string;
    worktreeId: string;
}

/**
 * The canonical spelling of a folder, or the path as given when it no longer exists.
 */
async function canonical(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return path;
    }
}

/**
 * The Workbench Root whose folder is `canonicalPath`. Both sides are compared canonically, because the Server reports
 * `/private/tmp/...` for a fixture created under `/tmp/...`.
 */
export async function matchWorkbenchRoot(
    roots: readonly WorkbenchRootChoice[],
    canonicalPath: string,
): Promise<WorkbenchRootChoice> {
    for (const root of roots) {
        // eslint-disable-next-line no-await-in-loop -- a handful of roots; stops at the first match.
        if ((await canonical(root.rootPath)) === canonicalPath) return root;
    }
    throw new CommandError(
        `The selected Session's repository has no linked worktree at ${canonicalPath}; create it with \`git worktree add\` first`,
    );
}

/**
 * Moves the selected Session into a linked worktree of its Project, as the status bar's Workbench Root picker does: an
 * undiscovered worktree is authorized through Main (`session.authorizeWorkbenchRoot`, which shows no native dialog), a
 * known one is selected. Verifying a surface that differs for a Session working in a worktree (sidebar labels, the
 * worktree badge) otherwise needs a hand-written CDP script.
 */
export async function enterWorktree(page: Page, path: string): Promise<void> {
    const { selectedSessionId: sessionId } = await request<{ selectedSessionId?: string }>(
        page,
        'app.bootstrap',
    );
    if (!sessionId) throw new CommandError('No Session is selected; run `new-session` first');
    const roots = await request<WorkbenchRootChoice[]>(page, 'session.workbenchRoots', {
        sessionId,
    });
    const root = await matchWorkbenchRoot(roots, await realpath(path));
    await (root.authorization === 'required' || !root.projectId
        ? request(page, 'session.authorizeWorkbenchRoot', {
              sessionId,
              worktreeId: root.worktreeId,
          })
        : request(page, 'session.selectWorkbenchRoot', { sessionId, projectId: root.projectId }));
}

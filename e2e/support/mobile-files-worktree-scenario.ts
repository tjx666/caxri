import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { BootstrapState, WorkbenchRootOption } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import { hasCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, tapMobileCheck, waitForMobile } from './mobile-android';
import type { Environment } from './mobile-project-panels-scenarios';
import { capture, finish } from './mobile-project-panels-scenarios';
import { git } from './mobile-pull-request-scenario';
import { openSessionSidePanel } from './mobile-session-panel';

const WORKTREE_BRANCH = 'feature/phone-worktree';

/**
 * Only the main worktree holds this file, so the Files root proves which worktree it lists.
 */
const MAIN_ONLY_FILE = 'main-only.txt';

/**
 * Seeds lowercase file names only: the Android helper exposes a `files-entry-*` check id only when it passes
 * `isAndroidCheckId`, so `README.md` would render but stay invisible to the scenario.
 */
async function seedRepoWithWorktree(root: string): Promise<void> {
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'fixture@caxri.test');
    await git(root, 'config', 'user.name', 'Caxri Fixture');
    await writeFile(join(root, 'notes.md'), 'Worktree fixture\n');
    await git(root, 'add', 'notes.md');
    await git(root, 'commit', '-m', 'Add the worktree fixture');
    await git(
        root,
        'worktree',
        'add',
        '-b',
        WORKTREE_BRANCH,
        join(dirname(root), 'phone-worktree'),
    );
    await writeFile(join(root, MAIN_ONLY_FILE), 'main\n');
}

/**
 * `MOB-FILES-WORKTREE-01`: Desktop moved the Session into a linked worktree; the phone's Files root names it and
 * switches the Session back to the main worktree, which Desktop then shows too.
 */
export async function executeMobileFilesWorktreeScenario(
    environment: Environment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        mode: 'launch-failure',
        seedProject: seedRepoWithWorktree,
        serial,
    });
    try {
        const { page } = fixture.running;
        const sessionId = fixture.allowedSessionId;
        if (!sessionId) throw new Error('The allowed Session is unavailable');
        const roots = await pageRequest<WorkbenchRootOption[]>(page, 'session.workbenchRoots', {
            sessionId,
        });
        const worktree = roots.find((root) => root.branch === WORKTREE_BRANCH);
        if (!worktree) throw new Error('The linked worktree is not a Workbench Root option');
        await pageRequest(page, 'session.authorizeWorkbenchRoot', {
            sessionId,
            worktreeId: worktree.worktreeId,
        });
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await openSessionSidePanel(serial, 'caxri.files');
        const linked = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => hasCheck(nodes, 'files-worktree') && hasCheck(nodes, 'files-entry-notes.md'),
        );
        if (hasCheck(linked, `files-entry-${MAIN_ONLY_FILE}`))
            throw new Error(
                'Files listed the main worktree while the Session was in the linked one',
            );
        await capture(environment, 'linked-worktree', artifacts);
        await tapMobileCheck(serial, 'files-worktree');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => hasCheck(nodes, 'files-worktree-option-main'),
        );
        await capture(environment, 'worktree-sheet', artifacts);
        await tapMobileCheck(serial, 'files-worktree-option-main');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => hasCheck(nodes, `files-entry-${MAIN_ONLY_FILE}`),
        );
        const state = await waitForMobile(
            () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
            (current) => {
                const session = current.sessions.find(({ id }) => id === sessionId);
                return session?.workbenchRootProjectId === session?.projectId;
            },
        );
        await capture(environment, 'main-worktree', artifacts);
        await finish(environment, artifacts, {
            desktopFollowed: state.sessions.some(
                (session) =>
                    session.id === sessionId &&
                    session.workbenchRootProjectId === session.projectId,
            ),
            filesListMainWorktree: true,
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

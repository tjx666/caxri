import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';

import type { BootstrapState, WorkbenchRootOption } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck } from './mobile-agent-chat-helpers';
import { mobileSemantics, waitForMobile } from './mobile-android';
import { BRANCH, git, SLUG, writeFakeGh } from './mobile-pull-request-scenario';

/**
 * Long enough that the row cannot show it whole beside the Project name and age on a phone.
 */
const WORKTREE_FOLDER = 'session-row-worktree-that-gives-way-before-the-project';

/**
 * A repository on `main` with a linked worktree on the published `BRANCH`, so the Session can move into that worktree
 * and Project Status finds the fake `gh`'s pull request for its branch. Returns the shared head.
 */
async function seedRepoWithWorktree(root: string): Promise<string> {
    await git(root, 'init', '-b', 'main');
    await git(root, 'config', 'user.email', 'fixture@caxri.test');
    await git(root, 'config', 'user.name', 'Caxri Fixture');
    await writeFile(join(root, 'README.md'), 'Session row fixture\n');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'Add the session row fixture');
    await git(root, 'remote', 'add', 'origin', `https://github.com/${SLUG}.git`);
    await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    await git(root, 'worktree', 'add', '-b', BRANCH, join(dirname(root), WORKTREE_FOLDER));
    await git(root, 'update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
    return git(root, 'rev-parse', 'HEAD');
}

/**
 * `MOB-SESSION-ROW-META-01`: a Session working in a linked worktree with an open pull request. Its row keeps the
 * Project name whole and truncates the long worktree name instead, and the status slot shows the pull request only
 * while the Session is settled: once the Agent runs, the spinner alone takes the slot, as on Desktop.
 */
export async function executeMobileSessionRowMetaScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const ghDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-gh-'));
    let mobile: Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;
    try {
        mobile = await createMobileAcceptanceFixture({
            mode: 'attention',
            serial,
            seedProject: async (root) => {
                const head = await seedRepoWithWorktree(root);
                await writeFakeGh(ghDirectory, 'ready', [{ head, number: 42, slug: SLUG }]);
            },
            env: { PATH: `${join(ghDirectory, 'bin')}:${process.env.PATH ?? ''}` },
        });
    } catch (error) {
        await rm(ghDirectory, { force: true, recursive: true });
        throw error;
    }
    try {
        const { page } = mobile.running;
        const sessionId = mobile.allowedSessionId;
        if (!sessionId || !mobile.attention) throw new Error('Session row fixture is unavailable');
        const roots = await pageRequest<WorkbenchRootOption[]>(page, 'session.workbenchRoots', {
            sessionId,
        });
        const worktree = roots.find((root) => root.branch === BRANCH);
        if (!worktree) throw new Error('The linked worktree is not a Workbench Root option');
        await pageRequest(page, 'session.authorizeWorkbenchRoot', {
            sessionId,
            worktreeId: worktree.worktreeId,
        });
        await mobile.pair();

        const row = `session-row-${sessionId}`;
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, row) &&
                hasCheck(nodes, 'session-row-worktree') &&
                hasCheck(nodes, 'session-row-pull-request'),
            60_000,
        );
        await capture(environment, 'settled', artifacts);

        await mobile.attention.trigger('fixture:start');
        await waitForMobile(
            () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
            (state) =>
                state.sessions.find((session) => session.id === sessionId)?.agentActivityState ===
                'running',
        );
        // The phone reads the dashboard change through its subscription; give it time to render.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await capture(environment, 'running', artifacts);
        await finish(environment, artifacts, {
            pullRequestWhileRunning: 'hidden',
            pullRequestWhileSettled: 'shown',
            status: 'passed',
        });
    } finally {
        await mobile.stop();
        await rm(ghDirectory, { force: true, recursive: true });
    }
}

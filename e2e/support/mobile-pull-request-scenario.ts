import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    tapMobileCheck,
    waitForMobile,
} from './mobile-android';

const execFileAsync = promisify(execFile);

const BRANCH = 'feature/phone-merge';
const SLUG = 'owner/example';

/**
 * The pull request the fake `gh` reports. `failing` has two failed checks among four, so the phone's confirmation names
 * them; `ready` has passing checks and a clean merge state, so its confirmation names only the pull request.
 */
type PullRequestFixture = 'failing' | 'ready';

const CHECKS: Record<PullRequestFixture, Array<{ name: string; conclusion: string }>> = {
    failing: [
        { name: 'lint', conclusion: 'FAILURE' },
        { name: 'e2e', conclusion: 'FAILURE' },
        { name: 'unit', conclusion: 'SUCCESS' },
        { name: 'build', conclusion: 'SUCCESS' },
    ],
    ready: [
        { name: 'lint', conclusion: 'SUCCESS' },
        { name: 'unit', conclusion: 'SUCCESS' },
    ],
};

async function git(root: string, ...arguments_: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', arguments_, { cwd: root });
    return stdout.trim();
}

/**
 * A branch with a published head on a GitHub remote, the shape Project Status needs before it looks up the branch's
 * pull request.
 */
async function seedRepo(root: string): Promise<void> {
    await git(root, 'init', '-b', BRANCH);
    await git(root, 'config', 'user.email', 'fixture@caxri.test');
    await git(root, 'config', 'user.name', 'Caxri Fixture');
    await writeFile(join(root, 'README.md'), 'Phone merge fixture\n');
    await git(root, 'add', 'README.md');
    await git(root, 'commit', '-m', 'Add the phone merge fixture');
    await git(root, 'remote', 'add', 'origin', `https://github.com/${SLUG}.git`);
    await git(root, 'update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
    await git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

/**
 * One GitHub repository the fake `gh` answers for: its slug, the head its branch is published at, and its pull request.
 */
interface FakeRepo {
    head: string;
    number: number;
    slug: string;
}

/**
 * The fake `gh` script for one repository: it answers the token read and the branch, pull request, and repository reads
 * from files, and records a merge by flipping the pull request to merged and appending its arguments to `mergeLog`.
 */
function fakeGhScript(
    repo: FakeRepo,
    fixture: PullRequestFixture,
    statePath: string,
    mergeLog: string,
): string {
    const rollup = CHECKS[fixture].map((check) => ({
        workflowName: 'CI',
        name: check.name,
        status: 'COMPLETED',
        conclusion: check.conclusion,
        startedAt: '2026-10-20T00:00:00.000Z',
        completedAt: '2026-10-20T00:02:00.000Z',
    }));
    const mergeStateStatus = fixture === 'failing' ? 'UNSTABLE' : 'CLEAN';
    const branchResponse = JSON.stringify({
        data: { repository: { ref: { target: { oid: repo.head } } } },
    });
    const pullRequest = (state: string) =>
        JSON.stringify({
            body: '',
            state,
            isDraft: false,
            number: repo.number,
            title: 'Let the phone merge a finished pull request',
            url: `https://github.com/${repo.slug}/pull/${repo.number}`,
            statusCheckRollup: rollup,
            headRefOid: repo.head,
            headRefName: BRANCH,
            baseRefName: 'main',
            mergeable: 'MERGEABLE',
            mergeStateStatus,
            ...(state === 'MERGED' && { mergeCommit: { oid: 'c'.repeat(40) } }),
        });
    return String.raw`#!/bin/sh
state=$(cat ${JSON.stringify(statePath)})
case "$1 $2" in
  "auth token") printf 'fixture-token' ;;
  "api graphql") printf '%s' '${branchResponse}' ;;
  "pr list") printf '[{"number":${repo.number},"state":"%s","isDraft":false}]' "$state" ;;
  "pr view")
    if [ "$state" = "MERGED" ]; then printf '%s' '${pullRequest('MERGED')}'; else printf '%s' '${pullRequest('OPEN')}'; fi ;;
  "repo view") printf '%s' '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":false}' ;;
  "pr merge")
    printf '%s\n' "$*" >> ${JSON.stringify(mergeLog)}
    printf 'MERGED' > ${JSON.stringify(statePath)} ;;
  *) printf 'unsupported gh call\n' >&2; exit 1 ;;
esac
`;
}

/**
 * A fake `gh` on `PATH` for one or more repositories. A call that names a later repository (its `owner/repo` slug, or
 * the GraphQL `name=` field) goes to that repository's script; every other call, including the token read, goes to the
 * first. All merges append to the one `merges.log`, so the order of merges across repositories stays visible.
 */
async function writeFakeGh(
    directory: string,
    fixture: PullRequestFixture,
    repos: readonly FakeRepo[],
): Promise<{ bin: string; mergeLog: string }> {
    const bin = join(directory, 'bin');
    const mergeLog = join(directory, 'merges.log');
    await mkdir(bin, { recursive: true });
    await writeFile(mergeLog, '');
    await Promise.all(
        repos.map(async (repo, index) => {
            const statePath = join(directory, `pull-request-state-${index}`);
            await writeFile(statePath, 'OPEN');
            await writeFile(
                join(bin, `gh-${index}`),
                fakeGhScript(repo, fixture, statePath, mergeLog),
                'utf8',
            );
        }),
    );
    const routes = repos
        .slice(1)
        .map((repo, offset) => {
            const name = repo.slug.split('/', 2)[1];
            return `  *" ${repo.slug} "*|*"name=${name} "*) exec sh ${JSON.stringify(join(bin, `gh-${offset + 1}`))} "$@" ;;`;
        })
        .join('\n');
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh\ncase " $* " in\n${routes}\n  *) exec sh ${JSON.stringify(join(bin, 'gh-0'))} "$@" ;;\nesac\n`,
        'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);
    return { bin, mergeLog };
}

/**
 * `MOB-CHAT-24` / `MOB-CHAT-25`: the Session header shows the Session's pull request as a chip; its sheet tells the
 * user whether it is ready and merges it from the phone. Every merge asks for a confirmation, because one stray tap on
 * a phone must not merge: with failed checks it names them (`failing`), and a ready one names only the pull request
 * (`ready`). Both pin GitHub's merge to the head the phone showed.
 */
export async function executeMobilePullRequestScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
    fixture: PullRequestFixture,
): Promise<void> {
    const { serial } = environment;
    // The fake `gh` needs the seeded head, so it is written while seeding, into a directory known before launch.
    const ghDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-gh-'));
    let head = '';
    let gh: { bin: string; mergeLog: string } | undefined;
    let mobile: Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;
    try {
        mobile = await createMobileAcceptanceFixture({
            chatProvider: 'claude',
            mode: 'agent-chat',
            serial,
            seedProject: async (root) => {
                await seedRepo(root);
                head = await git(root, 'rev-parse', 'HEAD');
                gh = await writeFakeGh(ghDirectory, fixture, [{ head, number: 42, slug: SLUG }]);
            },
            env: { PATH: `${join(ghDirectory, 'bin')}:${process.env.PATH ?? ''}` },
        });
    } catch (error) {
        await rm(ghDirectory, { force: true, recursive: true });
        throw error;
    }
    try {
        if (!gh || !mobile.allowedSessionId) throw new Error('Pull request fixture is unavailable');
        await mobile.pair();
        await tapMobileCheck(serial, `session-row-${mobile.allowedSessionId}`);
        await waitForCheck(serial, 'pull-request-chip', 60_000);
        await capture(environment, 'chip', artifacts);

        await tapMobileCheck(serial, 'pull-request-chip');
        await waitForCheck(serial, 'pull-request-merge');
        await capture(environment, 'sheet', artifacts);

        await tapMobileCheck(serial, 'pull-request-merge');
        await waitForCheck(serial, 'pull-request-confirm-merge');
        await capture(environment, 'confirmation', artifacts);
        await tapMobileCheck(serial, 'pull-request-confirm-merge');
        await waitForCheck(serial, 'pull-request-merge-outcome');
        // A merged pull request no longer offers Merge, even before Project Status reads it back as merged.
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => !hasCheck(nodes, 'pull-request-merge'),
        );
        await capture(environment, 'merged', artifacts);

        const merges = (await readFile(gh.mergeLog, 'utf8')).trim().split('\n').filter(Boolean);
        const expected = `pr merge 42 --repo ${SLUG} --squash --match-head-commit ${head}`;
        if (merges.length !== 1 || merges[0] !== expected)
            throw new Error(`GitHub merge calls did not match: ${JSON.stringify(merges)}`);
        await finish(environment, artifacts, {
            confirmation: fixture === 'failing' ? 'names-failed-checks' : 'names-pull-request',
            merge: 'squash-pinned-to-head',
        });
    } finally {
        await mobile.stop();
        await rm(ghDirectory, { force: true, recursive: true });
    }
}

const SUBMODULE_SLUG = 'owner/library';

/**
 * Adds a `library` submodule on the same branch, published on its own GitHub remote, so Project Status lists it as a
 * second repository with its own pull request. Returns the submodule's head.
 */
async function seedSubmodule(root: string, source: string): Promise<string> {
    await git(source, 'init', '-b', BRANCH);
    await git(source, 'config', 'user.email', 'fixture@caxri.test');
    await git(source, 'config', 'user.name', 'Caxri Fixture');
    await writeFile(join(source, 'README.md'), 'Library fixture\n');
    await git(source, 'add', 'README.md');
    await git(source, 'commit', '-m', 'Add the library fixture');
    await git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', source, 'library');
    await git(root, 'commit', '-m', 'Add the library submodule');
    await git(root, 'update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
    const library = join(root, 'library');
    await git(library, 'remote', 'set-url', 'origin', `https://github.com/${SUBMODULE_SLUG}.git`);
    await git(library, 'update-ref', `refs/remotes/origin/${BRANCH}`, 'HEAD');
    await git(library, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    await git(library, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return git(library, 'rev-parse', 'HEAD');
}

/**
 * The Status panel's Merge buttons, top to bottom: the first inline action of each row, `tree-row-action-<position>-0`,
 * which on a pull request row is its Merge. The panel lists the primary repository first, then its submodule.
 */
async function mergeButtons(serial: string) {
    return (await mobileSemantics(serial))
        .filter((node) => /^tree-row-action-[\d.]+-0$/u.test(node.checkId))
        .map((node) => androidBounds(node.bounds))
        .filter((bounds) => bounds !== null)
        .toSorted((left, right) => left.top - right.top);
}

/**
 * `MOB-CHAT-STATUS-TREE-MERGE-01`: the phone's Status panel carries Desktop's per-repository `Merge` button on each
 * pull request row, so a Session whose primary repository and submodule both have pull requests merges either one from
 * its own row; the Session header only ever merges the primary repository's. A ready pull request merges on one tap, as
 * on Desktop, through the same Extension command, pinned to the head the row showed, and its refreshed row stays but no
 * longer offers Merge.
 */
export async function executeMobileStatusTreeMergeScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const ghDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-gh-'));
    const libraryDirectory = await mkdtemp(join(tmpdir(), 'caxri-mobile-library-'));
    const heads = { library: '', primary: '' };
    let gh: { bin: string; mergeLog: string } | undefined;
    let mobile: Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;
    const cleanup = () =>
        Promise.all([
            rm(ghDirectory, { force: true, recursive: true }),
            rm(libraryDirectory, { force: true, recursive: true }),
        ]);
    try {
        mobile = await createMobileAcceptanceFixture({
            chatProvider: 'claude',
            mode: 'agent-chat',
            serial,
            seedProject: async (root) => {
                await seedRepo(root);
                heads.library = await seedSubmodule(root, libraryDirectory);
                heads.primary = await git(root, 'rev-parse', 'HEAD');
                gh = await writeFakeGh(ghDirectory, 'ready', [
                    { head: heads.primary, number: 42, slug: SLUG },
                    { head: heads.library, number: 7, slug: SUBMODULE_SLUG },
                ]);
            },
            env: { PATH: `${join(ghDirectory, 'bin')}:${process.env.PATH ?? ''}` },
        });
    } catch (error) {
        await cleanup();
        throw error;
    }
    try {
        if (!gh || !mobile.allowedSessionId) throw new Error('Pull request fixture is unavailable');
        const { mergeLog } = gh;
        const merges = async () =>
            (await readFile(mergeLog, 'utf8')).trim().split('\n').filter(Boolean);
        const tapMerge = async (index: number) => {
            const target = (await mergeButtons(serial)).at(index);
            if (!target) throw new Error(`Merge button ${index} is not on screen`);
            await adbShell(serial, [
                'input',
                'tap',
                String(Math.floor((target.left + target.right) / 2)),
                String(Math.floor((target.top + target.bottom) / 2)),
            ]);
        };
        await mobile.pair();
        await tapMobileCheck(serial, `session-row-${mobile.allowedSessionId}`);
        await tapMobileCheck(serial, 'session-segment-panel-caxri.project-status');
        // A build from before the row actions never shows the buttons; its baseline round still captures the panel.
        let buttons = 0;
        try {
            buttons = (
                await waitForMobile(
                    () => mergeButtons(serial),
                    (found) => found.length === 2,
                    60_000,
                )
            ).length;
        } catch {
            buttons = (await mergeButtons(serial)).length;
        }
        await capture(environment, 'status-two-merges', artifacts);
        if (buttons !== 2) {
            // Keep the capture and receipt, then fail, so the runner records the baseline round as `failed`.
            await finish(environment, artifacts, { mergeButtons: buttons, surface: 'status' });
            throw new Error(`Status panel shows ${buttons} Merge buttons instead of 2`);
        }

        // The lower row is the submodule's pull request, which the Session header never offers to merge.
        await tapMerge(1);
        await waitForMobile(merges, (log) => log.length === 1);
        await waitForMobile(
            () => mergeButtons(serial),
            (found) => found.length === 1,
        );
        await capture(environment, 'status-submodule-merged', artifacts);

        await tapMerge(0);
        await waitForMobile(merges, (log) => log.length === 2);
        await waitForMobile(
            () => mergeButtons(serial),
            (found) => found.length === 0,
        );
        await capture(environment, 'status-both-merged', artifacts);

        const expected = [
            `pr merge 7 --repo ${SUBMODULE_SLUG} --squash --match-head-commit ${heads.library}`,
            `pr merge 42 --repo ${SLUG} --squash --match-head-commit ${heads.primary}`,
        ];
        const log = await merges();
        if (JSON.stringify(log) !== JSON.stringify(expected))
            throw new Error(`GitHub merge calls did not match: ${JSON.stringify(log)}`);
        await writeFile(
            join(environment.assetsDirectory, `${environment.caseId}-merges.txt`),
            `${log.join('\n')}\n`,
        );
        await finish(environment, artifacts, {
            merges: ['submodule-squash-pinned-to-head', 'primary-squash-pinned-to-head'],
            surface: 'status',
        });
    } finally {
        await mobile.stop();
        await cleanup();
    }
}

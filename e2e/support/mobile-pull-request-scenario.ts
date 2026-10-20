import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck } from './mobile-android';

const execFileAsync = promisify(execFile);

const BRANCH = 'feature/phone-merge';
const SLUG = 'owner/example';

/**
 * The pull request the fake `gh` reports. `failing` has two failed checks among four, so the phone asks before merging
 * anyway; `ready` has passing checks and a clean merge state, so one tap merges it.
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
}

/**
 * A fake `gh` that answers branch, pull request, and repository reads from files, and records a merge by flipping the
 * pull request to merged and appending its arguments to `merges.log`.
 */
async function writeFakeGh(
    directory: string,
    fixture: PullRequestFixture,
    head: string,
): Promise<{ bin: string; mergeLog: string }> {
    const bin = join(directory, 'bin');
    const statePath = join(directory, 'pull-request-state');
    const mergeLog = join(directory, 'merges.log');
    await mkdir(bin, { recursive: true });
    await Promise.all([writeFile(statePath, 'OPEN'), writeFile(mergeLog, '')]);
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
        data: { repository: { ref: { target: { oid: head } } } },
    });
    const pullRequest = (state: string) =>
        JSON.stringify({
            body: '',
            state,
            isDraft: false,
            number: 42,
            title: 'Let the phone merge a finished pull request',
            url: `https://github.com/${SLUG}/pull/42`,
            statusCheckRollup: rollup,
            headRefOid: head,
            headRefName: BRANCH,
            mergeable: 'MERGEABLE',
            mergeStateStatus,
            ...(state === 'MERGED' && { mergeCommit: { oid: 'c'.repeat(40) } }),
        });
    await writeFile(
        join(bin, 'gh'),
        String.raw`#!/bin/sh
state=$(cat ${JSON.stringify(statePath)})
case "$1 $2" in
  "api graphql") printf '%s' '${branchResponse}' ;;
  "pr list") printf '[{"number":42,"state":"%s","isDraft":false}]' "$state" ;;
  "pr view")
    if [ "$state" = "MERGED" ]; then printf '%s' '${pullRequest('MERGED')}'; else printf '%s' '${pullRequest('OPEN')}'; fi ;;
  "repo view") printf '%s' '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":false}' ;;
  "pr merge")
    printf '%s\n' "$*" >> ${JSON.stringify(mergeLog)}
    printf 'MERGED' > ${JSON.stringify(statePath)} ;;
  *) printf 'unsupported gh call\n' >&2; exit 1 ;;
esac
`,
        'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);
    return { bin, mergeLog };
}

/**
 * `MOB-CHAT-24` / `MOB-CHAT-25`: the Session header shows the Session's pull request as a chip; its sheet tells the
 * user whether it is ready and merges it from the phone. A pull request with failed checks asks for a second
 * confirmation that names them (`failing`); a ready one merges with one tap (`ready`). Both pin GitHub's merge to the
 * head the phone showed.
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
                gh = await writeFakeGh(ghDirectory, fixture, head);
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
        if (fixture === 'failing') {
            await waitForCheck(serial, 'pull-request-confirm-merge');
            await capture(environment, 'confirmation', artifacts);
            await tapMobileCheck(serial, 'pull-request-confirm-merge');
        }
        await waitForCheck(serial, 'pull-request-merge-outcome');
        await capture(environment, 'merged', artifacts);

        const merges = (await readFile(gh.mergeLog, 'utf8')).trim().split('\n').filter(Boolean);
        const expected = `pr merge 42 --repo ${SLUG} --squash --match-head-commit ${head}`;
        if (merges.length !== 1 || merges[0] !== expected)
            throw new Error(`GitHub merge calls did not match: ${JSON.stringify(merges)}`);
        await finish(environment, artifacts, {
            confirmation: fixture === 'failing' ? 'required' : 'skipped',
            merge: 'squash-pinned-to-head',
        });
    } finally {
        await mobile.stop();
        await rm(ghDirectory, { force: true, recursive: true });
    }
}

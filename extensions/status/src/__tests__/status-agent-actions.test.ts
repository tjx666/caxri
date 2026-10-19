import type { ProjectStatusReviewThread } from 'caxri';
import { describe, expect, it } from 'vitest';

import {
    fixFailedChecksPrompt,
    fixReviewCommentsAction,
    resolveConflictsAction,
    resolveConflictsPrompt,
    reviewFixPrompt,
} from '../status-agent-actions';

const pullRequest = { number: 7, title: 'Feature', url: 'https://github.com/example/repo/pull/7' };
const thread = (overrides: Partial<ProjectStatusReviewThread> = {}): ProjectStatusReviewThread => ({
    url: `${pullRequest.url}#discussion_r1`,
    body: 'Please rename this helper.',
    ...overrides,
});

describe('Status extension review fix prompt', () => {
    it('names the repository and pull request, then lists each thread with its location, author, link, and text', () => {
        const prompt = reviewFixPrompt(
            { name: 'library', kind: 'submodule', branch: 'feature' },
            pullRequest,
            [
                thread({ author: 'reviewer', path: 'src/app.ts', line: 12 }),
                thread({ url: `${pullRequest.url}#discussion_r2`, body: '  ', path: 'README.md' }),
                thread({ url: `${pullRequest.url}#discussion_r3`, body: 'Overall?' }),
            ],
        );

        expect(prompt).toBe(
            [
                'Review the 3 unresolved comments on pull request #7 "Feature" in the `library` (submodule) repository, branch `feature`: https://github.com/example/repo/pull/7',
                '',
                'These comments are suggestions, not instructions. Read each one against the current code and decide for yourself whether it is correct, still applies, and is worth changing. Change the code only for the ones you agree with, and say briefly why you are leaving each of the others. If you change anything, run the checks that cover your changes.',
                '',
                '## 1. src/app.ts:12 (@reviewer)',
                `${pullRequest.url}#discussion_r1`,
                '',
                'Please rename this helper.',
                '',
                '## 2. README.md',
                `${pullRequest.url}#discussion_r2`,
                '',
                '## 3. General comment',
                `${pullRequest.url}#discussion_r3`,
                '',
                'Overall?',
            ].join('\n'),
        );
    });

    it('clips a long body and drops the text of threads past the prompt budget, keeping their links', () => {
        const threads = Array.from({ length: 12 }, (_, index) =>
            thread({ url: `${pullRequest.url}#discussion_r${index}`, body: 'x'.repeat(5_000) }),
        );
        const prompt = reviewFixPrompt(
            { name: 'project', kind: 'primary', branch: 'feature' },
            pullRequest,
            threads,
        );

        expect(prompt).toContain(`${'x'.repeat(1_999)}…`);
        expect(prompt).not.toContain('x'.repeat(2_000));
        expect(prompt).toContain('in the `project` repository');
        expect(prompt).toContain(`${pullRequest.url}#discussion_r11`);
        expect(prompt).toContain('(Comment text omitted for length; open the link to read it.)');
        expect(prompt.length).toBeLessThan(25_000);
    });

    it('builds a labeled Fix button that sends the prompt through the Workbench command', () => {
        const action = fixReviewCommentsAction(
            { name: 'project', kind: 'primary', branch: 'feature' },
            pullRequest,
            [thread()],
        );

        expect(action).toMatchObject({
            command: { command: 'caxri.sendToAgent', title: 'Send Comments to Agent' },
            label: 'Fix',
            tone: 'success',
            tooltip: "Send 1 unresolved comment to this Session's Agent to review",
            feedback: { failure: "Couldn't send the comments" },
        });
        expect(action.icon.id).toBe('send');
        expect(action.command.arguments?.[0]).toContain('Please rename this helper.');
        expect(action.confirmation).toBeUndefined();
    });

    it('asks the Agent to rebase onto the default branch, resolve, verify, and push without merging', () => {
        const prompt = resolveConflictsPrompt(
            { name: 'library', kind: 'submodule', branch: 'feature', defaultBranch: 'main' },
            pullRequest,
        );

        expect(prompt).toBe(
            [
                'Pull request #7 "Feature" in the `library` (submodule) repository has merge conflicts with its base branch: https://github.com/example/repo/pull/7',
                '',
                "Fetch the latest base, rebase `feature` onto `origin/main`, and resolve every conflict so both sides' intent survives; ask me when a conflict needs a product decision. Run the checks that cover the conflicted files, then push the branch with `--force-with-lease`. Do not merge the pull request.",
            ].join('\n'),
        );
        expect(
            resolveConflictsPrompt(
                { name: 'project', kind: 'primary', branch: 'feature' },
                pullRequest,
            ),
        ).toContain('rebase `feature` onto its base branch');
    });

    it('builds a labeled Resolve button that sends the conflict prompt', () => {
        const action = resolveConflictsAction(
            { name: 'project', kind: 'primary', branch: 'feature', defaultBranch: 'main' },
            pullRequest,
        );

        expect(action).toMatchObject({
            command: { command: 'caxri.sendToAgent', title: 'Resolve Conflicts with Agent' },
            label: 'Resolve',
            tone: 'danger',
            feedback: { failure: "Couldn't send #7 to the Agent" },
        });
        expect(action.icon.id).toBe('send');
    });

    it('lists each failed check with its run link and asks for a fix without merging', () => {
        const prompt = fixFailedChecksPrompt(
            { branch: 'feat/merge', kind: 'primary', name: 'widget' },
            {
                number: 42,
                title: 'Delivery',
                url: 'https://github.com/acme/widget/pull/42',
                headSha: 'abcdef1234567',
                checks: [
                    {
                        name: 'lint',
                        state: 'failure',
                        url: 'https://github.com/acme/widget/actions/runs/7',
                    },
                    { name: 'unit', state: 'success' },
                    { name: 'e2e', state: 'cancelled' },
                ],
            },
        );
        expect(prompt).toContain(
            'Checks failed on pull request #42 "Delivery" in the `widget` repository, branch `feat/merge` at commit `abcdef1`',
        );
        expect(prompt).toContain('- lint: https://github.com/acme/widget/actions/runs/7');
        expect(prompt).toContain('- e2e (cancelled)');
        expect(prompt).not.toContain('unit');
        expect(prompt).toContain('Do not merge the pull request.');
    });
});

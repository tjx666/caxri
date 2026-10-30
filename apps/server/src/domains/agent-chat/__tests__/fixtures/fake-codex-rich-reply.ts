/**
 * `richreply`: the streaming benchmark's workload for the Chat's specially rendered references. One turn opens twenty
 * pull requests and twenty issues through `gh` (one tracker card each), edits forty files (one edited-files card), and
 * streams a reply of 120 sections whose every line links a pull request, an issue, a source file, and a skill.
 */
import crypto from 'node:crypto';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

const TRACKERS = 20;
const EDITED_FILES = 40;
const SECTIONS = 120;

/**
 * GitHub repository every link and tracker card points at. The benchmark answers its `gh` reads with a fake `gh`, so
 * nothing reaches GitHub.
 */
const REPOSITORY = 'acme/widgets';

function trackerCommand(kind: 'issue' | 'pr', index: number) {
    const number = (kind === 'pr' ? 1000 : 2000) + index;
    return {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: `/bin/zsh -lc "gh ${kind} create --title 'Widget change ${index}' --body 'Benchmark tracker ${index}.'"`,
        cwd: process.cwd(),
        status: 'completed',
        aggregatedOutput: `https://github.com/${REPOSITORY}/${kind === 'pr' ? 'pull' : 'issues'}/${number}\n`,
        exitCode: 0,
        durationMs: 5,
    };
}

function richSection(index: number): string {
    const pullRequest = 1000 + (index % TRACKERS);
    const issue = 2000 + (index % TRACKERS);
    const file = `src/widgets/module-${index % EDITED_FILES}.ts`;
    return [
        `### Step ${index}`,
        '',
        `Merged [PR widgets#${pullRequest}](https://github.com/${REPOSITORY}/pull/${pullRequest}) and closed ` +
            `[issue widgets#${issue}](https://github.com/${REPOSITORY}/issues/${issue}); the change lives in ` +
            `\`${file}:${12 + index}\`, see also ${file}:${20 + index}.`,
        `- Followed \`repo-helper\` and the [notes](https://docs.example.test/step-${index}) for this step.`,
        `- Checked \`docs/step-${index}.md\` against \`src/widgets/index.ts\`.`,
        '',
    ].join('\n');
}

export async function runRichReply(io: FakeCodexIo, turn: FakeTurn) {
    for (let index = 0; index < TRACKERS; index += 1) {
        io.completeItem(turn, trackerCommand('pr', index));
        io.completeItem(turn, trackerCommand('issue', index));
    }
    io.completeItem(turn, {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'completed',
        changes: Array.from({ length: EDITED_FILES }, (_, index) => ({
            path: `${process.cwd()}/src/widgets/module-${index}.ts`,
            kind: { type: 'update', move_path: null },
            diff: `@@ -1 +1,2 @@\n export const value${index} = ${index};\n+export const next${index} = ${index + 1};\n`,
        })),
    });
    const reply = [
        ...Array.from({ length: SECTIONS }, (_, index) => richSection(index)),
        `Linked ${SECTIONS} steps.`,
    ].join('\n');
    const deltas = reply.match(/[\s\S]{1,24}/gu) ?? [];
    await io.streamMessage(turn, deltas, 4);
}

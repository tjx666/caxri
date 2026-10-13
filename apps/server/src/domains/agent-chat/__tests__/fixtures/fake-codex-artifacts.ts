/**
 * `artifacts`: a turn that edits and creates files on disk, opens a pull request through `gh`, rewrites another pull
 * request's body through `gh api`, files a Linear issue through MCP, and publishes an acceptance report through `lh`,
 * so the Chat's turn-end cards (edited files with Undo, tracker cards) have something real to show.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

const AFTER =
    'export function greet(name: string) {\n    const greeting = `Hello, ${name}!`;\n    return greeting;\n}\n';
const CREATED = '# Greeting\n\nCall `greet(name)`.\n';
const ACCEPTANCE_ID = '00000000-0000-4000-8000-000000000042';

export async function runTurnArtifacts(io: FakeCodexIo, turn: FakeTurn) {
    const edited = path.join(process.cwd(), 'src', 'greeting.ts');
    const created = path.join(process.cwd(), 'docs', 'greeting.md');
    fs.mkdirSync(path.dirname(edited), { recursive: true });
    fs.mkdirSync(path.dirname(created), { recursive: true });
    fs.writeFileSync(edited, AFTER);
    fs.writeFileSync(created, CREATED);
    io.completeItem(turn, {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'completed',
        changes: [
            {
                path: edited,
                kind: { type: 'update', move_path: null },
                diff: [
                    '@@ -1,3 +1,4 @@',
                    ' export function greet(name: string) {',
                    "-    return 'Hello ' + name;",
                    '+    const greeting = `Hello, ${name}!`;',
                    '+    return greeting;',
                    ' }',
                    '',
                ].join('\n'),
            },
            { path: created, kind: { type: 'add' }, diff: CREATED },
        ],
    });
    io.completeItem(turn, {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: `/bin/zsh -lc "gh pr create --title 'Greet with punctuation' --body 'Adds a comma and an exclamation mark to the greeting.'"`,
        cwd: process.cwd(),
        status: 'completed',
        aggregatedOutput: 'https://github.com/acme/widgets/pull/42\n',
        exitCode: 0,
        durationMs: 5,
    });
    io.completeItem(turn, {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: `/bin/zsh -lc "gh api -X PATCH repos/acme/widgets/pulls/40 -F body=@/tmp/pr-40.md --jq .html_url"`,
        cwd: process.cwd(),
        status: 'completed',
        aggregatedOutput: 'https://github.com/acme/widgets/pull/40\n',
        exitCode: 0,
        durationMs: 5,
    });
    io.completeItem(turn, {
        type: 'mcpToolCall',
        id: crypto.randomUUID(),
        server: 'linear',
        tool: 'save_issue',
        status: 'completed',
        arguments: { title: 'Document the greeting', team: 'ENG' },
        result: {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        identifier: 'ENG-12',
                        title: 'Document the greeting',
                        url: 'https://linear.app/acme/issue/ENG-12/document-the-greeting',
                        description: 'Explain how `greet` formats a name.',
                    }),
                },
            ],
        },
        durationMs: 5,
    });
    io.completeItem(turn, {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: `/bin/zsh -lc "lh acceptance run ingest round-1 --requirement 'Greeting ends with punctuation' --json"`,
        cwd: process.cwd(),
        status: 'completed',
        aggregatedOutput: `${JSON.stringify(
            {
                acceptanceId: ACCEPTANCE_ID,
                acceptanceUrl: `https://app.lobehub.com/acceptance/${ACCEPTANCE_ID}`,
                cases: 3,
                roundIndex: 1,
                roundUrl: `https://app.lobehub.com/acceptance/${ACCEPTANCE_ID}?r=1`,
            },
            null,
            2,
        )}\n`,
        exitCode: 0,
        durationMs: 5,
    });
    await io.streamMessage(turn, 'Updated the greeting and opened a pull request.', 0);
}

/**
 * `manyfiles`: a turn that creates five notes on disk, more than a turn card lists before folding the rest away.
 */
export async function runTurnManyFiles(io: FakeCodexIo, turn: FakeTurn) {
    const changes = Array.from({ length: 5 }, (_, index) => {
        const file = path.join(process.cwd(), 'notes', `note-${index + 1}.md`);
        const content = `# Note ${index + 1}\n`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        return { path: file, kind: { type: 'add' }, diff: content };
    });
    io.completeItem(turn, {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'completed',
        changes,
    });
    await io.streamMessage(turn, 'Wrote five notes.', 0);
}

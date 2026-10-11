/**
 * `artifacts`: a turn that edits and creates files on disk, opens a pull request through `gh`, and files a Linear issue
 * through MCP, so the Chat's turn-end cards (edited files with Undo, tracker cards) have something real to show.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

const AFTER =
    'export function greet(name: string) {\n    const greeting = `Hello, ${name}!`;\n    return greeting;\n}\n';
const CREATED = '# Greeting\n\nCall `greet(name)`.\n';

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
    await io.streamMessage(turn, 'Updated the greeting and opened a pull request.', 0);
}

/**
 * Approval scenarios for the fake Codex app-server (`fake-codex-app-server.ts`): a command and a file change that ask
 * for approval (`approve`, `patch`) and a question for the user (`ask`), each through an app-server request to the
 * client. Kept apart so the app-server stand-in stays readable.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import type { FakeCodexIo, FakeTurn } from './fake-codex-io.ts';

interface ApprovalResponse {
    decision?: string;
}
interface QuestionResponse {
    answers?: Record<string, { answers: string[] } | undefined>;
}

/**
 * `approve`: a command needing approval; accept runs it, decline records it as declined.
 */
export async function runApprovalCommand(io: FakeCodexIo, turn: FakeTurn) {
    const command = {
        type: 'commandExecution',
        id: crypto.randomUUID(),
        command: 'echo approved',
        cwd: process.cwd(),
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
    };
    io.startItem(turn, { ...command });
    const response = (await io.serverRequest('item/commandExecution/requestApproval', {
        turnId: turn.id,
        itemId: command.id,
        startedAtMs: Date.now(),
        command: command.command,
        cwd: command.cwd,
        reason: 'Fake approval',
        // The list real Codex sends for a command approval: no `decline`, though it accepts one.
        availableDecisions: [
            'accept',
            { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } },
            'cancel',
        ],
    })) as ApprovalResponse | undefined;
    if (response?.decision === 'accept' || response?.decision === 'acceptForSession') {
        io.notifyTurn(turn, 'item/commandExecution/outputDelta', {
            turnId: turn.id,
            itemId: command.id,
            delta: 'approved\n',
        });
        io.completeItem(turn, {
            ...command,
            status: 'completed',
            aggregatedOutput: 'approved\n',
            exitCode: 0,
            durationMs: 5,
        });
        await io.streamMessage(turn, 'The command ran.', 0);
    } else {
        io.completeItem(turn, { ...command, status: 'declined' });
        await io.streamMessage(turn, 'The command was declined.', 0);
    }
}

/**
 * `patch`: a three-file change (update, add, delete) needing approval; nothing is written to disk.
 */
export async function runApprovalPatch(io: FakeCodexIo, turn: FakeTurn) {
    const change = {
        type: 'fileChange',
        id: crypto.randomUUID(),
        status: 'inProgress',
        changes: [
            {
                path: path.join(process.cwd(), 'src', 'greeting.ts'),
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
            {
                path: path.join(process.cwd(), 'docs', 'greeting.md'),
                kind: { type: 'add' },
                diff: '# Greeting\n\nCall `greet(name)`.\n',
            },
            {
                path: path.join(process.cwd(), 'legacy.txt'),
                kind: { type: 'delete' },
                diff: 'unused\n',
            },
        ],
    };
    io.startItem(turn, { ...change });
    const response = (await io.serverRequest('item/fileChange/requestApproval', {
        turnId: turn.id,
        itemId: change.id,
        startedAtMs: Date.now(),
        reason: 'Fake file change',
        grantRoot: null,
    })) as ApprovalResponse | undefined;
    const isAccepted = response?.decision === 'accept' || response?.decision === 'acceptForSession';
    io.completeItem(turn, { ...change, status: isAccepted ? 'completed' : 'declined' });
    await io.streamMessage(
        turn,
        isAccepted ? 'The files were changed.' : 'The change was declined.',
        0,
    );
}

/**
 * `ask`: a question; the reply quotes the chosen answer.
 */
export async function runQuestion(io: FakeCodexIo, turn: FakeTurn) {
    const item = { type: 'dynamicToolCall', id: crypto.randomUUID() };
    const response = (await io.serverRequest('item/tool/requestUserInput', {
        turnId: turn.id,
        itemId: item.id,
        questions: [
            {
                id: 'color',
                header: 'Color',
                question: 'Which color?',
                isOther: true,
                isSecret: false,
                options: [
                    { label: 'Red', description: 'Warm' },
                    { label: 'Blue', description: 'Cool' },
                ],
            },
        ],
    })) as QuestionResponse | undefined;
    const answer = response?.answers?.color?.answers[0];
    await io.streamMessage(turn, `You chose ${answer ?? 'nothing'}.`, 0);
}

/**
 * `several questions`: three questions in one request, the first with a recommended option and the last free-text only;
 * the reply lists every answer, with `-` for a question left unanswered.
 */
export async function runQuestions(io: FakeCodexIo, turn: FakeTurn) {
    const item = { type: 'dynamicToolCall', id: crypto.randomUUID() };
    const question = (id: string, header: string, text: string, labels: string[]) => ({
        id,
        header,
        question: text,
        isOther: true,
        isSecret: false,
        options: labels.map((label) => ({ label, description: `${label} description` })),
    });
    const response = (await io.serverRequest('item/tool/requestUserInput', {
        turnId: turn.id,
        itemId: item.id,
        questions: [
            question('split', 'Split', 'How should traffic split?', [
                'Per user (Recommended)',
                'Per request',
            ]),
            question('scope', 'Scope', 'Which users count as free?', [
                'Free and Hobby',
                'Free only',
            ]),
            question('fallback', 'Fallback', 'Anything else to keep in mind?', []),
        ],
    })) as QuestionResponse | undefined;
    const answers = ['split', 'scope', 'fallback'].map(
        (id) => response?.answers?.[id]?.answers[0] ?? '-',
    );
    await io.streamMessage(turn, `You answered ${answers.join(' / ')}.`, 0);
}

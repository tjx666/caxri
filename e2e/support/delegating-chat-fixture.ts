import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import {
    fakeClaudeChatExecutableSource,
    fakeCodexChatExecutableSource,
} from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
import { createFakeAgentMode } from './agent-fixture.ts';
import type { RunningCaxri } from './helpers.ts';
import { closeAppQuietly, createProjectSession, launchCaxri, pageRequest } from './helpers.ts';
import type { LaunchCaxriOptions } from './launch-options.ts';

/**
 * The folder name of the Project every Session in these specs lives in, which is the Project's title.
 */
export const DELEGATING_PROJECT = 'delegating-project';
export const CHILD_TITLE = 'Review the retry design';
export const CHILD_SUMMARY = 'The retry design is sound.';
/**
 * The message that makes the parent's fake Agent run the Caxri CLI and delegate a task.
 */
export const DELEGATE_PROMPT = 'delegate the review';
/**
 * The parent's reply to the notice that its failed task was retried.
 */
export const RETRY_NOTICE_REPLY = 'Noted: waiting on the retried task.';
/**
 * The parent's reply to the settlement notice the Server sends when its delegated task finishes. Without a scripted
 * turn the fake Agent would answer an unknown prompt with a file-change approval and block the Chat.
 */
export const SETTLEMENT_NOTICE_REPLY = 'Noted: the delegated review finished.';
/**
 * Present in the control directory while the delegated child's turn is held; removing it lets the child finish.
 */
export const HOLD_CHILD_FILE = 'hold-child';

/**
 * A shell command that runs the built Caxri CLI with `args`, as a fake Agent's command step does.
 */
export function caxriCliCommand(arguments_: string): string {
    const cliPath = join(import.meta.dirname, '..', '..', 'apps/cli/dist/caxri.cjs');
    return `${process.execPath} ${cliPath} ${arguments_}`;
}

export interface DelegatingChat {
    controlDirectory: string;
    directory: string;
    launchOptions: LaunchCaxriOptions;
    running: RunningCaxri;
    scriptPath: string;
    taskPath: string;
    userData: string;
    cleanup(): Promise<void>;
    /**
     * Writes the scripted turns for a Project: the parent delegates `CHILD_TITLE` through the real Caxri CLI (with the
     * configured `preset` when the launch asked for one), and the child's reply ends in a `Summary:` line after it is
     * released. Must run before the first Chat opens, because the fake Agent reads its script once at startup.
     */
    writeScript(projectId: string): Promise<void>;
}

/**
 * Launches the app with a fake Codex whose Chat can run real shell commands (so the Caxri CLI acts as that Chat) and
 * enables Open Agents In Chat so a delegated child opens as a Chat too. `withClaude` also installs a fake Claude Code.
 * The Project is created by the caller.
 */
export async function launchDelegatingChat(
    prefix: string,
    options: {
        /**
         * Delegates with `--consult`, so the child takes no sidebar row and opens beside the parent's Chat.
         */
        consult?: boolean;
        env?: NodeJS.ProcessEnv;
        preset?: string;
        withClaude?: boolean;
    } = {},
): Promise<DelegatingChat> {
    const temporary = await mkdtemp(join(tmpdir(), `${prefix}-`));
    const directory = await realpath(temporary);
    const userData = join(directory, 'profile');
    const root = join(directory, DELEGATING_PROJECT);
    const controlDirectory = join(directory, 'control');
    const scriptPath = join(directory, 'script.json');
    const taskPath = join(directory, 'task.md');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(controlDirectory)]);
    await writeFile(taskPath, 'Review the retry design and report back.');
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            // A second installed Agent is what a usage-limit failure can switch to; its replies stay canned.
            ...(options.withClaude && {
                claude: { executableSource: fakeClaudeChatExecutableSource({}) },
            }),
            codex: {
                executableSource: fakeCodexChatExecutableSource({
                    stateDirectory: join(directory, 'codex-threads'),
                    nativeUsageHome: join(userData, 'e2e-agents', 'codex'),
                    // Thread ids become UUIDv7, which is how the ledger finds a thread's rollout.
                    shouldWriteRollouts: true,
                    scriptPath,
                    controlDirectory,
                }),
            },
        },
    });
    const launchOptions = {
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        ...(options.env && { env: options.env }),
    };
    const running = await launchCaxri(launchOptions);
    const chat: DelegatingChat = {
        controlDirectory,
        directory,
        launchOptions,
        running,
        scriptPath,
        taskPath,
        userData,
        cleanup: async () => {
            await closeAppQuietly(chat.running.app);
            await rm(directory, { recursive: true, force: true });
        },
        writeScript: async (projectId) => {
            const create = [
                caxriCliCommand('agent delegate create'),
                `--project ${projectId} --new-session${options.consult ? ' --consult' : ''} --title "${CHILD_TITLE}"`,
                `${options.preset ? `--preset ${options.preset}` : '--provider codex'} --prompt-file ${taskPath}`,
                '--request-id e2e-delegated-review --json',
            ].join(' ');
            await writeFile(
                scriptPath,
                JSON.stringify({
                    turns: [
                        {
                            prompt: DELEGATE_PROMPT,
                            steps: [
                                // A second command makes the settled turn fold, so the record's survival is observable.
                                { kind: 'command', command: 'echo preparing', output: 'preparing' },
                                { kind: 'command', command: create, output: '', shouldRun: true },
                                { kind: 'message', text: 'Delegated the review to a new Session.' },
                            ],
                        },
                        {
                            // The child's first message is a pointer to its task that ends in a generated ID.
                            prompt: 'Read the delegated task from ',
                            isPrefix: true,
                            steps: [
                                { kind: 'hold', file: HOLD_CHILD_FILE },
                                {
                                    kind: 'message',
                                    text: `Reviewed the retry design.\n\nSummary: ${CHILD_SUMMARY}`,
                                },
                            ],
                        },
                        {
                            prompt: '[Caxri] Delegated task update',
                            isPrefix: true,
                            steps: [{ kind: 'message', text: SETTLEMENT_NOTICE_REPLY }],
                        },
                        {
                            // The notice a parent receives when the owner retries its failed task.
                            prompt: 'Delegated task ',
                            isPrefix: true,
                            steps: [{ kind: 'message', text: RETRY_NOTICE_REPLY }],
                        },
                    ],
                }),
            );
        },
    };
    try {
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({
                ...settings.value,
                'session.openAgentsInChat': true,
                ...(options.preset && {
                    'agents.delegation': {
                        ...settings.value['agents.delegation'],
                        presets: [
                            {
                                name: options.preset,
                                provider: 'codex',
                                effort: 'high',
                                useWhen: 'Review a change',
                            },
                        ],
                    },
                }),
            }),
        });
    } catch (error) {
        await chat.cleanup();
        throw error;
    }
    return chat;
}

/**
 * Creates the parent Session and returns its ID with its Project's ID.
 */
export async function createParentSession(
    chat: DelegatingChat,
): Promise<{ projectId: string; sessionId: string }> {
    const { page } = chat.running;
    const sessionId = await createProjectSession(page, 'shell');
    const state = await pageRequest<BootstrapState>(page, 'app.bootstrap');
    const projectId = state.sessions.find((session) => session.id === sessionId)!.projectId;
    return { projectId, sessionId };
}

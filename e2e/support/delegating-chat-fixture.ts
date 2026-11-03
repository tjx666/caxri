import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState } from '@caxri/protocol';

import { fakeCodexChatExecutableSource } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
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
 * Present in the control directory while the delegated child's turn is held; removing it lets the child finish.
 */
export const HOLD_CHILD_FILE = 'hold-child';

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
     * Writes the scripted turns for a Project: the parent delegates `CHILD_TITLE` through the real Caxri CLI, and the
     * child's reply ends in a `Summary:` line after it is released. Must run before the first Chat opens, because the
     * fake Agent reads its script once at startup.
     */
    writeScript(projectId: string): Promise<void>;
}

/**
 * Launches the app with a fake Codex whose Chat can run real shell commands (so the Caxri CLI acts as that Chat) and
 * enables Open Agents In Chat so a delegated child opens as a Chat too. The Project is created by the caller.
 */
export async function launchDelegatingChat(prefix: string): Promise<DelegatingChat> {
    const temporary = await mkdtemp(join(tmpdir(), `${prefix}-`));
    const directory = await realpath(temporary);
    const userData = join(directory, 'profile');
    const root = join(directory, DELEGATING_PROJECT);
    const controlDirectory = join(directory, 'control');
    const scriptPath = join(directory, 'script.json');
    const taskPath = join(directory, 'task.md');
    await Promise.all([mkdir(root, { recursive: true }), mkdir(controlDirectory)]);
    await writeFile(taskPath, 'Review the retry design and report back.');
    const cliPath = join(import.meta.dirname, '..', '..', 'apps/cli/dist/caxri.cjs');
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: fakeCodexChatExecutableSource({
                    stateDirectory: join(directory, 'codex-threads'),
                    nativeUsageHome: join(userData, 'e2e-agents', 'codex'),
                    scriptPath,
                    controlDirectory,
                }),
            },
        },
    });
    const launchOptions = { agentMode, userDataDir: userData, testRootPath: root };
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
                process.execPath,
                cliPath,
                'agent delegate create',
                `--project ${projectId} --new-session --title "${CHILD_TITLE}"`,
                `--provider codex --prompt-file ${taskPath} --request-id e2e-delegated-review --json`,
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
                    ],
                }),
            );
        },
    };
    try {
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify({ ...settings.value, 'session.openAgentsInChat': true }),
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

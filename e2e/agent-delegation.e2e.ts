import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type {
    AgentDelegationAnswer,
    AgentDelegationReceipt,
    AppSettings,
    BootstrapState,
} from '@caxri/protocol';

import { fakeClaudeChatExecutableSource } from '../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
import { delegationFixtureSource } from '../scripts/agent-delegation-fixture.ts';
import { fakeCodexChatProvider } from './support/agent-chat-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

for (const [callerProvider, targetProvider] of [
    ['codex', 'claude'],
    ['claude', 'codex'],
    ['claude', 'grok'],
    ['grok', 'claude'],
] as const) {
    test(`visible ${targetProvider} delegation from ${callerProvider} preserves caller focus and returns the exact durable answer`, async () => {
        const testInfo = test.info();
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-e2e-'));
        const userData = join(directory, 'profile');
        const root = join(directory, 'project');
        const contextPath = join(directory, 'context.json');
        const resultPath = join(directory, 'result.json');
        const cliPath = join(import.meta.dirname, '..', 'apps/cli/dist/caxri.cjs');
        await mkdir(root);
        const agentMode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                [callerProvider]: {
                    executableSource: String.raw`#!${process.execPath}
// 合成调用方通过继承的受管凭据运行真实 CLI，仅保存非秘密上下文及断言回执。
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if(process.argv.includes('--version')) { console.log(${JSON.stringify(callerProvider === 'codex' ? 'codex-cli 0.153.4' : callerProvider === 'grok' ? 'grok 1.0.24' : '2.1.266 (Claude Code)')}); process.exit(0); }
// 该超时必须覆盖最长的 CLI 内部等待（delegate wait --timeout 20000）外加进程启动与 IPC 往返。
// 原值 25000 只留 5 秒余量，在三个 Electron worker 共用 runner 时不够，这正是此前把本规格挡在并行池外的原因。
const cli = args => spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...args, '--json'], {encoding:'utf8',env:process.env,timeout:45000});
const contextCall = cli(['agent-context']);
if(contextCall.status !== 0) process.exit(1);
const context = JSON.parse(contextCall.stdout);
fs.writeFileSync(${JSON.stringify(contextPath)}, JSON.stringify(context));
process.stdin.setRawMode?.(true);
let launched = false;
process.stdin.on('data', chunk => {
  if(launched || !chunk.toString().includes('delegate')) return;
  launched = true;
  const taskPath = ${JSON.stringify(join(directory, 'task.md'))};
  fs.writeFileSync(taskPath,'Synthetic task');
  const roster=cli(['agent','delegate','presets','--project',context.endpoint.projectId,'--session',context.endpoint.sessionId]);
  if(roster.status!==0||JSON.parse(roster.stdout).presets[0]?.provider!==${JSON.stringify(targetProvider)}){fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({code:99}));return;}
  const args=['agent','delegate','create','--project',context.endpoint.projectId,'--session',context.endpoint.sessionId,'--preset','synthetic-review','--prompt-file',taskPath,'--request-id','synthetic-delegation'];
  const created=cli(args);
  if(created.status!==0){fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({code:created.status}));return;}
  const receipt=JSON.parse(created.stdout);
  const retried=cli(args);
  const waited=cli(['agent','delegate','wait',receipt.delegationId,'--timeout','20000']);
  const result=waited.status===0?JSON.parse(waited.stdout):null;
  const followArgs=[...args.slice(0,-1),'synthetic-follow-up','--follow-up',receipt.delegationId];
  const follow=cli(followArgs);
  const followReceipt=follow.status===0?JSON.parse(follow.stdout):null;
  const followWait=followReceipt?cli(['agent','delegate','wait',followReceipt.delegationId,'--timeout','20000']):null;
  const followResult=followWait?.status===0?JSON.parse(followWait.stdout):null;
  const resumeArgs=[...args.slice(0,-1),'synthetic-resume','--resume',followReceipt?.delegationId??'missing'];
  const resumed=cli(resumeArgs);
  const resumedReceipt=resumed.status===0?JSON.parse(resumed.stdout):null;
  const resumeWait=resumedReceipt?cli(['agent','delegate','wait',resumedReceipt.delegationId,'--timeout','20000']):null;
  const resumeResult=resumeWait?.status===0?JSON.parse(resumeWait.stdout):null;
  if(![result,followResult,resumeResult].every(value=>value?.receipt.usage?.inputTokens===10&&value?.receipt.usage?.outputTokens===5)){fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({code:98,outcomes:[result,followResult,resumeResult].map(value=>({status:value?.receipt.status,failure:value?.receipt.failure,correlationFailure:value?.receipt.correlationFailure}))}));return;}
  fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({code:waited.status,receipt:result?.receipt,retriedSame:retried.status===0&&JSON.parse(retried.stdout).delegationId===receipt.delegationId,answerMatched:result?.answer?.text==='Synthetic delegation complete',followStatus:followResult?.receipt.status,followAnswerMatched:followResult?.answer?.text==='Synthetic follow-up complete',resumeStatus:resumeResult?.receipt.status,resumeFailure:resumeResult?.receipt.failure,resumeAnswerMatched:resumeResult?.answer?.text==='Synthetic resume complete',sameTerminal:followReceipt?.terminalId===receipt.terminalId&&resumedReceipt?.terminalId===receipt.terminalId}));
  process.stdout.write('Synthetic caller collected delegated answer\r\n');
});

process.stdin.resume();
process.stdout.write('Synthetic caller ready\r\n');
`,
                },
                [targetProvider]: {
                    executableSource: delegationFixtureSource(targetProvider),
                },
            },
        });
        const running = await launchCaxri({
            agentMode,
            userDataDir: userData,
            testRootPath: root,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        });
        try {
            const settings = await pageRequest<{ value: AppSettings }>(
                running.page,
                'settings.get',
            );
            settings.value['agents.delegation'] = {
                maxDepth: 2,
                presets: [
                    {
                        name: 'synthetic-review',
                        provider: callerProvider,
                        model: 'base-model',
                        effort: 'high',
                        useWhen: 'Review a synthetic task',
                    },
                ],
                callers: {
                    [callerProvider]: {
                        presets: { 'synthetic-review': { provider: targetProvider } },
                    },
                },
            };
            settings.value['agents.providers'].grok.hooks.enabled = true;
            await pageRequest(running.page, 'settings.update', {
                source: JSON.stringify(settings.value),
            });
            const sessionId = await createProjectSession(running.page, callerProvider);
            await expect(running.page.locator('.xterm-rows')).toContainText(
                'Synthetic caller ready',
            );
            const context = JSON.parse(await readFile(contextPath, 'utf8')) as {
                endpoint: {
                    ref: { hostId: string; endpointId: string; generation: number };
                    terminalId: string;
                };
            };
            const before = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            await pageRequest(running.page, 'terminal.input', {
                terminalId: context.endpoint.terminalId,
                data: 'delegate\r',
            });
            await expect
                .poll(
                    async () => {
                        try {
                            return JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
                        } catch (error) {
                            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                            throw error;
                        }
                    },
                    { timeout: 60000 },
                )
                .toMatchObject({
                    code: 0,
                    retriedSame: true,
                    answerMatched: true,
                    followStatus: 'completed',
                    followAnswerMatched: true,
                    resumeStatus: 'completed',
                    resumeAnswerMatched: true,
                    sameTerminal: true,
                    receipt: {
                        status: 'completed',
                        callerTerminalId: context.endpoint.terminalId,
                        depth: 1,
                        selection: { provider: targetProvider, preset: 'synthetic-review' },
                    },
                });
            const receipt = (
                JSON.parse(await readFile(resultPath, 'utf8')) as {
                    receipt: AgentDelegationReceipt;
                }
            ).receipt;
            await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
            const after = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            expect(
                after.sessionStates.find((state) => state.sessionId === sessionId)?.paneLayout
                    .activePaneId,
            ).toBe(
                before.sessionStates.find((state) => state.sessionId === sessionId)?.paneLayout
                    .activePaneId,
            );
            await expect
                .poll(
                    async () => {
                        const result = await pageRequest<{
                            receipt: AgentDelegationReceipt;
                            answer?: AgentDelegationAnswer;
                        }>(running.page, 'agent.delegation.result', {
                            delegationId: receipt.delegationId,
                        });
                        return result.receipt.status;
                    },
                    { timeout: 20_000 },
                )
                .toBe('completed');
            const result = await pageRequest<{
                receipt: AgentDelegationReceipt;
                answer?: AgentDelegationAnswer;
            }>(running.page, 'agent.delegation.result', { delegationId: receipt.delegationId });
            expect(result.answer?.text).toBe('Synthetic delegation complete');
            expect(result.answer?.truncated).toBe(false);
            await running.page.screenshot({ path: testInfo.outputPath('visible-delegation.png') });
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });

    test(`stopped ${callerProvider} to ${targetProvider} delegation survives app restart and explicitly resumes its exact native conversation`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-restart-'));
        const userDataDirectory = join(directory, 'profile');
        const root = join(directory, 'project');
        await mkdir(root);
        const agentMode = await createFakeAgentMode({
            userDataDir: userDataDirectory,
            providers: {
                [targetProvider]: { executableSource: delegationFixtureSource(targetProvider) },
            },
        });
        const launchOptions = {
            agentMode,
            userDataDir: userDataDirectory,
            testRootPath: root,
            env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        };
        let running = await launchCaxri(launchOptions);
        try {
            const settings = await pageRequest<{ value: AppSettings }>(
                running.page,
                'settings.get',
            );
            settings.value['agents.providers'].grok.hooks.enabled = true;
            await pageRequest(running.page, 'settings.update', {
                source: JSON.stringify(settings.value),
            });
            const sessionId = await createProjectSession(running.page, 'shell');
            const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            const projectId = bootstrap.sessions.find(
                (session) => session.id === sessionId,
            )!.projectId;
            const common = {
                projectId,
                sessionId,
                provider: targetProvider,
                prompt: 'Synthetic restart task',
            };
            const initial = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.create',
                common,
            );
            const completed = await pageRequest<{ receipt: AgentDelegationReceipt }>(
                running.page,
                'agent.delegation.wait',
                { delegationId: initial.delegationId, timeoutMs: 20000 },
            );
            expect(completed.receipt.status).toBe('completed');
            /**
             * A follow-up is admitted only while the parent's launch is still the Terminal's current one, and the
             * Server treats a launch as current only once the Host has reported its process. Read that readiness from
             * the projected Terminal before asking, and assert the admission itself before stopping: on CI this stop
             * once answered `target_changed` with nothing in the test saying whether the follow-up was ever admitted
             * (github.com/tjx666/caxri/issues/933). When this assertion fails, the Server log's
             * `agent_delegation.admission_rejected` entry names the exact rejection reason.
             */
            await expect
                .poll(async () => {
                    const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
                    const terminal = state.terminals.find(
                        (candidate) => candidate.id === initial.terminalId,
                    );
                    return {
                        processState: terminal?.lastAgentProcessState,
                        hasNativeSession: Boolean(terminal?.agentSessionId),
                    };
                })
                .toEqual({ processState: 'running', hasNativeSession: true });
            const followed = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.create',
                { ...common, followUpOf: initial.delegationId },
            );
            expect(followed).toMatchObject({
                status: 'submitting',
                terminalId: initial.terminalId,
                followUpOf: initial.delegationId,
            });
            const stopped = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.stop',
                { delegationId: followed.delegationId },
            );
            expect(stopped).toMatchObject({ status: 'interrupted', failure: 'caller_stopped' });
            const before = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            const nativeSessionId = before.terminals.find(
                (terminal) => terminal.id === initial.terminalId,
            )!.agentSessionId;
            expect(nativeSessionId).toBeTruthy();
            await running.app.close();
            running = await launchCaxri(launchOptions);
            await pageRequest(running.page, 'session.select', { sessionId });
            const restored = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            const target = restored.terminals.find(
                (terminal) => terminal.id === initial.terminalId,
            )!;
            expect(target.agentSessionId).toBe(nativeSessionId);
            expect(target.lastAgentProcessState).not.toBe('running');
            const resumed = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.create',
                { ...common, resumeFrom: followed.delegationId },
            );
            expect(resumed.terminalId).toBe(initial.terminalId);
            const result = await pageRequest<{
                receipt: AgentDelegationReceipt;
                answer?: AgentDelegationAnswer;
            }>(running.page, 'agent.delegation.wait', {
                delegationId: resumed.delegationId,
                timeoutMs: 20000,
            });
            expect(result.receipt.status).toBe('completed');
            expect(result.answer?.text).toBe('Synthetic resume complete');
            const after = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            expect(
                after.terminals.find((terminal) => terminal.id === resumed.terminalId)
                    ?.agentSessionId,
            ).toBe(nativeSessionId);
            const previous = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.status',
                { delegationId: followed.delegationId },
            );
            expect(previous).toMatchObject({ status: 'interrupted', failure: 'caller_stopped' });
            await expect(running.page.locator('.workbench-pane')).toHaveCount(2);
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}

for (const provider of ['codex', 'claude'] as const) {
    test(`${provider} delegation opens its child as an Agent Chat when Open Agents in Chat is on, and collects each answer from the Chat, including an exact resume`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-chat-'));
        const userData = join(directory, 'profile');
        const root = join(directory, 'project');
        await mkdir(root);
        const agentMode = await createFakeAgentMode({
            userDataDir: userData,
            providers: {
                [provider]:
                    provider === 'codex'
                        ? fakeCodexChatProvider(directory)
                        : { executableSource: fakeClaudeChatExecutableSource() },
            },
        });
        const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
        try {
            const settings = await pageRequest<{ value: AppSettings }>(
                running.page,
                'settings.get',
            );
            await pageRequest(running.page, 'settings.update', {
                source: JSON.stringify({ ...settings.value, 'session.openAgentsInChat': true }),
            });
            const sessionId = await createProjectSession(running.page, 'shell');
            const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            const common = {
                projectId: bootstrap.sessions.find((session) => session.id === sessionId)!
                    .projectId,
                sessionId,
                provider,
                prompt: 'Synthetic Chat task',
            };
            interface Result {
                receipt: AgentDelegationReceipt;
                answer?: AgentDelegationAnswer;
            }
            const wait = (delegationId: string) =>
                pageRequest<Result>(running.page, 'agent.delegation.wait', {
                    delegationId,
                    timeoutMs: 20000,
                });
            const initial = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.create',
                common,
            );
            const first = await wait(initial.delegationId);
            expect(first.receipt.status).toBe('completed');
            // The fake echoes the Chat message it got, so the answer proves the pointer arrived as the first message.
            expect(first.answer?.text).toMatch(
                new RegExp(
                    String.raw`You said: Read the delegated task from .+ Delegation ID: ${initial.delegationId}\.$`,
                    'u',
                ),
            );
            const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
            expect(
                state.terminals.find((terminal) => terminal.id === initial.terminalId)?.surface,
            ).toBe('chat');
            await expect(
                running.page
                    .locator('.workbench-pane')
                    .getByText(/You said: Read the delegated task/u),
            ).toBeVisible();
            // The pointer bubble shows the task the caller wrote rather than leaving only "Delegated task".
            await expect(
                running.page.locator(`[data-agent-chat-delegated-task="${initial.delegationId}"]`),
            ).toContainText('Synthetic Chat task');
            await running.page.screenshot({
                path: test.info().outputPath(`${provider}-delegated-task.png`),
            });

            const followed = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.create',
                { ...common, followUpOf: initial.delegationId },
            );
            expect(followed.terminalId).toBe(initial.terminalId);
            const second = await wait(followed.delegationId);
            expect(second.receipt.status).toBe('completed');
            expect(second.answer?.text).toMatch(/You said: Read the delegated task from /u);
            expect(second.answer?.text).not.toBe(first.answer?.text);

            // The child Chat is still live and idle: an exact resume replaces its own launch in the same Terminal.
            const resumed = await pageRequest<AgentDelegationReceipt>(
                running.page,
                'agent.delegation.create',
                { ...common, resumeFrom: followed.delegationId },
            );
            expect(resumed.terminalId).toBe(initial.terminalId);
            const third = await wait(resumed.delegationId);
            expect(third.receipt.status).toBe('completed');
            expect(third.answer?.text).toMatch(
                new RegExp(String.raw`Delegation ID: ${resumed.delegationId}\.$`, 'u'),
            );
        } finally {
            await running.app.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
}

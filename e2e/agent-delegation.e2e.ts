import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type {
    AgentDelegationAnswer,
    AgentDelegationReceipt,
    BootstrapState,
} from '@caxri/protocol';

import { delegationFixtureSource } from '../scripts/agent-delegation-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

test('visible delegation preserves caller focus and returns the exact durable answer', async () => {
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
            codex: {
                executableSource: String.raw`#!${process.execPath}
// 合成调用方通过继承的受管凭据运行真实 CLI，仅保存非秘密上下文及断言回执。
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if(process.argv.includes('--version')) { console.log('codex-cli 0.151.0'); process.exit(0); }
const cli = args => spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...args, '--json'], {encoding:'utf8',env:process.env,timeout:25000});
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
  const args=['agent','delegate','create','--project',context.endpoint.projectId,'--session',context.endpoint.sessionId,'--provider','claude','--prompt-file',taskPath,'--request-id','synthetic-delegation'];
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
  fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({code:waited.status,receipt:result?.receipt,retriedSame:retried.status===0&&JSON.parse(retried.stdout).delegationId===receipt.delegationId,answerMatched:result?.answer?.text==='Synthetic delegation complete',followStatus:followResult?.receipt.status,followAnswerMatched:followResult?.answer?.text==='Synthetic follow-up complete',resumeStatus:resumeResult?.receipt.status,resumeFailure:resumeResult?.receipt.failure,resumeAnswerMatched:resumeResult?.answer?.text==='Synthetic resume complete',sameTerminal:followReceipt?.terminalId===receipt.terminalId&&resumedReceipt?.terminalId===receipt.terminalId}));
  process.stdout.write('Synthetic caller collected delegated answer\r\n');
});

process.stdin.resume();
process.stdout.write('Synthetic caller ready\r\n');
`,
            },
            claude: {
                executableSource: delegationFixtureSource(),
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
        const sessionId = await createProjectSession(running.page, 'codex');
        await expect(running.page.locator('.xterm-rows')).toContainText('Synthetic caller ready');
        const context = JSON.parse(await readFile(contextPath, 'utf8')) as {
            endpoint: {
                ref: { hostId: string; endpointId: string; generation: number };
                terminalId: string;
            };
        };
        await pageRequest(running.page, 'agent.grant', {
            endpoint: context.endpoint.ref,
            policy: 'agent:delegate',
            ttlMs: 60000,
        });
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
                receipt: { status: 'completed', callerTerminalId: context.endpoint.terminalId },
            });
        const receipt = (
            JSON.parse(await readFile(resultPath, 'utf8')) as { receipt: AgentDelegationReceipt }
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

test('stopped delegation survives app restart and explicitly resumes its exact native conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-restart-'));
    const userDataDirectory = join(directory, 'profile');
    const root = join(directory, 'project');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: { claude: { executableSource: delegationFixtureSource() } },
    });
    const launchOptions = {
        agentMode,
        userDataDir: userDataDirectory,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    };
    let running = await launchCaxri(launchOptions);
    try {
        const sessionId = await createProjectSession(running.page, 'shell');
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const projectId = bootstrap.sessions.find((session) => session.id === sessionId)!.projectId;
        const common = {
            projectId,
            sessionId,
            provider: 'claude' as const,
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
        const followed = await pageRequest<AgentDelegationReceipt>(
            running.page,
            'agent.delegation.create',
            { ...common, followUpOf: initial.delegationId },
        );
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
        const target = restored.terminals.find((terminal) => terminal.id === initial.terminalId)!;
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
            after.terminals.find((terminal) => terminal.id === resumed.terminalId)?.agentSessionId,
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

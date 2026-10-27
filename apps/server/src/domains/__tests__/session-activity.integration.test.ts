import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createTestTerminalExecution } from '../../__tests__/support/terminal';
import { createFakePty, createPendingAgentAdapters } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

describe('Session Activity domain integration', () => {
    it('advances only when managed Agent input is submitted', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-session-activity-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const events: ServerEvent[] = [];
        const logger = new StructuredLogger(join(directory, 'logs'));
        const execution = createTestTerminalExecution(logger, {
            spawn: () => createFakePty(),
        });
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger,
            send: (event) => events.push(event),
            terminal: {
                agentEnvironment: () => Promise.resolve({ PATH: '/usr/bin' }),
                execution,
                resolveExecutable: (kind) =>
                    Promise.resolve(kind === 'shell' ? '/bin/zsh' : '/usr/bin/codex'),
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'codex',
            });
            const initialActivityAt = created.session.sessionActivityAt;
            expect(created.terminal).toMatchObject({
                kind: 'codex',
                lastAgentProcessState: 'running',
                lastProcessState: 'running',
                provider: 'codex',
            });
            expect(execution.processId(created.terminal!.id)).toBe(4242);
            expect(execution.agentProcessId(created.terminal!.id)).toBe(4242);

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: 'echo pending',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.sessionActivityAt,
            ).toBe(initialActivityAt);

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: '\u{15}\r',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.sessionActivityAt,
            ).toBe(initialActivityAt);

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: '\u{1B}[200~echo pasted\necho pending\u{1B}[201~',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.sessionActivityAt,
            ).toBe(initialActivityAt);

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: '\r',
            });
            expect((await runtime.handlers['app.bootstrap']({})).sessions[0]).toMatchObject({
                sessionActivityReason: 'user_submission',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.sessionActivityAt,
            ).toBeGreaterThan(initialActivityAt);
            expect(events).toContainEqual({
                event: 'state.changed',
                payload: {
                    kind: 'records',
                    sessionIds: [created.session.id],
                    terminalIds: [],
                },
            });
        } finally {
            await runtime.close();
        }
    });

    it('routes submitted Shell input through provider promotion tracking', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-shell-activity-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const logger = new StructuredLogger(join(directory, 'logs'));
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger,
            send: () => {},
            terminal: {
                execution: createTestTerminalExecution(logger, { spawn: () => createFakePty() }),
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
            },
            agentAdapters: createPendingAgentAdapters(),
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: 'codex\r',
            });

            expect((await runtime.handlers['app.bootstrap']({})).sessions[0]).toMatchObject({
                sessionActivityReason: 'user_submission',
            });
        } finally {
            await runtime.close();
        }
    });
});

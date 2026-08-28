import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDomainServices } from '../../__tests__/support/domain-services';
import { createFakePty } from './create-test-domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
    temporaryDirectories.length = 0;
});

describe('Session Activity domain integration', () => {
    it('advances only when Terminal input is submitted', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-session-activity-'));
        temporaryDirectories.push(directory);
        const projectRoot = join(directory, 'project');
        await mkdir(projectRoot);
        const events: ServerEvent[] = [];
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger: new StructuredLogger(join(directory, 'logs')),
            send: (event) => events.push(event),
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: projectRoot });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const initialActivityAt = created.session.lastSessionActivityAt;

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: 'echo pending',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.lastSessionActivityAt,
            ).toBe(initialActivityAt);

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: '\u{15}\r',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.lastSessionActivityAt,
            ).toBe(initialActivityAt);

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: '\u{1B}[200~echo pasted\necho pending\u{1B}[201~',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.lastSessionActivityAt,
            ).toBe(initialActivityAt);

            await runtime.handlers['terminal.input']({
                terminalId: created.terminal!.id,
                data: '\r',
            });
            expect((await runtime.handlers['app.bootstrap']({})).sessions[0]).toMatchObject({
                lastSessionActivityReason: 'user_submission',
            });
            expect(
                (await runtime.handlers['app.bootstrap']({})).sessions[0]?.lastSessionActivityAt,
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
});

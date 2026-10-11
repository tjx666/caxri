import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { CommandAdapter, ServerEvent } from '@caxri/protocol';
import { createCommandDispatcher } from '@caxri/protocol';
import { logEventCatalog, StructuredLogger } from '@caxri/system';
import { afterEach, describe, expect, it } from 'vitest';

import { createTestDomainServices } from '../../../__tests__/support/domain-services';
import { createFakePty } from '../../__tests__/create-test-domain-services';
import type { DomainOperation } from '../../domain-services';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const paths = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })));
});

describe('Runtime business introspection', () => {
    it('shares bounded handlers and deduplicates Settings mutations by request ID', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-runtime-business-'));
        const homeDirectory = await mkdtemp(join(homedir(), '.caxri-runtime-business-'));
        temporaryDirectories.push(directory, homeDirectory);
        const events: ServerEvent[] = [];
        const logger = new StructuredLogger(join(directory, 'logs'));
        const runtime = await createTestDomainServices({
            userDataPath: join(directory, 'user-data'),
            logger,
            send: (event) => {
                events.push(event);
            },
            terminal: {
                resolveExecutable: () => Promise.resolve('/bin/zsh'),
                spawn: () => createFakePty(),
            },
        });

        try {
            const project = await runtime.handlers['project.create']({ rootPath: homeDirectory });
            const created = await runtime.handlers['session.create']({
                projectId: project.id,
                defaultAgent: 'shell',
            });
            const principal = { kind: 'human-cli' as const, id: 'human-test' };
            expect(
                runtime.handlers['project.queryForPrincipal']({
                    principal,
                    query: { mode: 'current' },
                }),
            ).toMatchObject({
                view: 'human-cli',
                projects: [{ id: project.id, rootPath: `$HOME/${basename(homeDirectory)}` }],
            });
            expect(
                runtime.handlers['session.queryForPrincipal']({
                    principal,
                    query: { mode: 'show', selector: created.session.id },
                }),
            ).toMatchObject({
                sessions: [{ id: created.session.id, projectId: project.id }],
            });
            expect(
                runtime.handlers['terminal.queryForPrincipal']({
                    principal,
                    query: { mode: 'list', sessionId: created.session.id },
                }),
            ).toMatchObject({ terminals: [{ id: created.terminal!.id }] });

            const adapter: CommandAdapter = {
                invoke: (request) => {
                    const handler = runtime.handlers[request.method as DomainOperation] as (
                        parameters: unknown,
                    ) => unknown;
                    return handler(request.params);
                },
            };
            const dispatch = createCommandDispatcher({ server: adapter });
            const context = { principal, capabilities: ['settings.write'] as const };
            const request = {
                protocolVersion: 2,
                id: 'settings-once',
                method: 'settings.patch',
                params: {
                    changes: [{ key: 'terminal.fontSize', value: 18 }],
                    dryRun: false,
                },
            };
            events.length = 0;
            const first = await dispatch(request, context);
            const duplicate = await dispatch(request, context);
            expect(first).toEqual(duplicate);
            expect(events.filter(({ event }) => event === 'settings.changed')).toHaveLength(1);
            expect((await runtime.handlers['settings.inspect']({})).value).toMatchObject({
                'terminal.fontSize': 18,
            });

            logger.write('error', logEventCatalog.serverCore.uncaughtException, {
                correlationId: 'safe-error-id',
                fields: {
                    error: 'operation failed',
                    token: 'secret-sentinel',
                    source: homeDirectory,
                },
            });
            const externalEvent = 'runtime.external_failure';
            await appendFile(
                logger.path,
                `${JSON.stringify({
                    timestamp: new Date().toISOString(),
                    process: 'server-core',
                    level: 'warn',
                    event: externalEvent,
                    correlationId: 'external-error-id',
                })}\n`,
            );
            const logs = await runtime.handlers['logs.query']({ limit: 100 });
            const snapshot = await runtime.handlers['diagnostics.snapshot']({});
            // Structured fields surface for the log viewer, but secret-keyed values stay redacted and home paths stay
            // substituted end to end.
            expect(logs.records).toContainEqual(
                expect.objectContaining({
                    event: logEventCatalog.serverCore.uncaughtException,
                    correlationId: 'safe-error-id',
                    fields: {
                        error: 'operation failed',
                        token: '[REDACTED]',
                        source: `$HOME/${basename(homeDirectory)}`,
                    },
                }),
            );
            expect(logs.records).toContainEqual(
                expect.objectContaining({
                    event: externalEvent,
                    correlationId: 'external-error-id',
                }),
            );
            expect(snapshot).toMatchObject({
                runtimeStatus: 'ready',
                projectCount: 1,
                sessionCount: 1,
                terminalCount: 1,
                recentErrorIds: ['server-core:safe-error-id'],
            });
            expect(snapshot).not.toHaveProperty('terminalHost');
            expect(JSON.stringify({ logs, snapshot })).not.toContain('secret-sentinel');
            expect(JSON.stringify({ logs, snapshot })).not.toContain(homeDirectory);
        } finally {
            await runtime.close();
        }
    });
});

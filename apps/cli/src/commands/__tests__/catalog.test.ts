import { resolve } from 'node:path';
import { cwd } from 'node:process';

import { methods } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { hasQuietIds } from '../../output';
import { CLI_COMMANDS, findCliCommand } from '../catalog';
import type { CliCommandDefinition, RemoteCommandDefinition } from '../types';

describe('CLI business command catalog', () => {
    it('registers every bounded business and diagnostics command', () => {
        const paths = CLI_COMMANDS.map(({ path }) => path.join(' '));

        expect(paths).toEqual(
            expect.arrayContaining([
                'status',
                'open',
                'reveal',
                'project list',
                'project show',
                'project current',
                'project add',
                'session list',
                'session show',
                'session current',
                'terminal list',
                'terminal show',
                'settings get',
                'settings validate',
                'settings patch',
                'logs query',
                'logs follow',
                'diagnostics snapshot',
                'events watch',
                'agent list',
                'agent grants',
                'agent grant',
                'agent revoke',
                'agent dispatch start',
                'agent dispatch resume',
                'agent dispatch status',
                'agent dispatch wait',
                'agent control interrupt',
                'agent control stop',
                'agent message send',
                'agent message wait',
                'agent message check',
                'agent message reply',
                'agent message receipt',
                'agent message policy',
                'agent message policy-set',
                'bot board',
                'bot session create',
                'bot session archive',
                'bot session hand-over',
                'bot session take-back',
                'bot task list',
                'bot task add',
                'bot task update',
                'terminal send',
                'skills list',
                'skills get',
                'skills status',
                'skills install',
                'skills update',
                'skills uninstall',
            ]),
        );
    });

    it('adds one folder as a Project, resolved from the caller working directory', () => {
        const add = findCliCommand(['project', 'add', 'repo']);

        expect(add?.kind === 'remote' && add.parseParams(['../repo'])).toEqual({
            path: resolve(cwd(), '../repo'),
        });
        expect(add?.kind === 'remote' && add.parseParams(['/work/repo'])).toEqual({
            path: '/work/repo',
        });
        expect(() => add?.parseParams([])).toThrow(/exactly one folder path/u);
        expect(() => add?.parseParams(['a', 'b'])).toThrow(/Unexpected argument: b/u);
    });

    it('archives exactly one Caxri Bot Session by ID', () => {
        const archive = findCliCommand(['bot', 'session', 'archive', 'session-1']);
        if (archive?.kind !== 'remote') throw new Error('bot session archive is missing');
        expect(archive.method).toBe('bot.session.archive');
        expect(archive.parseParams(['session-1'])).toEqual({ sessionId: 'session-1' });
        expect(() => archive.parseParams([])).toThrow('requires one <session-id>');
        expect(() => archive.parseParams(['session-1', 'session-2'])).toThrow(
            'requires one <session-id>',
        );
        expect(() => archive.parseParams(['--project'])).toThrow('requires one <session-id>');
    });

    it('hands Sessions over and takes one back by ID', async () => {
        const handOver = findCliCommand(['bot', 'session', 'hand-over', 'session-1']);
        const takeBack = findCliCommand(['bot', 'session', 'take-back', 'session-1']);
        if (handOver?.kind !== 'remote' || takeBack?.kind !== 'remote')
            throw new Error('bot session hand-over or take-back is missing');
        expect(handOver.method).toBe('bot.session.handOver');
        await expect(handOver.parseParams(['session-1', 'session-2'])).resolves.toEqual({
            sessionIds: ['session-1', 'session-2'],
            conversations: [],
        });
        await expect(handOver.parseParams([])).rejects.toThrow(
            'requires at least one <session-id>',
        );
        await expect(handOver.parseParams(['session-1', '--force'])).rejects.toThrow(
            'Unexpected argument: --force',
        );
        expect(takeBack.method).toBe('bot.session.takeBack');
        expect(takeBack.parseParams(['session-1'])).toEqual({ sessionId: 'session-1' });
        expect(() => takeBack.parseParams([])).toThrow('requires one <session-id>');
    });

    it('parses scoped selectors and bounded diagnostic filters', () => {
        const session = findCliCommand(['session', 'show', 'Work', '--project', 'project-1']);
        const logs = findCliCommand([
            'logs',
            'query',
            '--process',
            'server-core',
            '--level',
            'error',
            '--limit',
            '25',
        ]);

        expect(session?.kind).toBe('remote');
        expect(
            session?.kind === 'remote'
                ? session.parseParams(['Work', '--project', 'project-1'])
                : null,
        ).toEqual({ mode: 'show', selector: 'Work', projectId: 'project-1' });
        expect(logs?.kind).toBe('remote');
        expect(
            logs?.kind === 'remote'
                ? logs.parseParams([
                      '--process',
                      'server-core',
                      '--level',
                      'error',
                      '--limit',
                      '25',
                  ])
                : null,
        ).toEqual({ process: 'server-core', level: 'error', limit: 25 });

        const grant = findCliCommand(['agent', 'grant']);
        expect(
            grant?.kind === 'remote'
                ? grant.parseParams([
                      `${'a'.repeat(32)}:endpoint-1:2`,
                      'debug:read',
                      '--ttl-ms',
                      '60000',
                  ])
                : null,
        ).toEqual({
            endpoint: { hostId: 'a'.repeat(32), endpointId: 'endpoint-1', generation: 2 },
            policy: 'debug:read',
            ttlMs: 60_000,
        });

        const message = findCliCommand(['agent', 'message', 'reply']);
        expect(
            message?.kind === 'remote'
                ? message.parseParams([
                      '--to',
                      `${'a'.repeat(32)}:endpoint-2:3`,
                      '--reply-to',
                      'message-1',
                      '--body',
                      'plain peer text',
                  ])
                : null,
        ).toEqual({
            to: { hostId: 'a'.repeat(32), endpointId: 'endpoint-2', generation: 3 },
            replyTo: 'message-1',
            body: 'plain peer text',
        });

        const open = findCliCommand([
            'open',
            'src/main/index.ts',
            '--session',
            'session-1',
            '--no-launch',
        ]);
        expect(
            open?.kind === 'remote'
                ? open.parseParams(['src/main/index.ts', '--session', 'session-1', '--no-launch'])
                : null,
        ).toEqual({
            path: 'src/main/index.ts',
            sessionId: 'session-1',
            launchIfNeeded: false,
        });

        const wake = findCliCommand(['agent', 'message', 'send']);
        expect(
            wake?.kind === 'remote'
                ? wake.parseParams([
                      '--to',
                      `${'a'.repeat(32)}:endpoint-2:3`,
                      '--body',
                      'wake safely',
                      '--wake',
                  ])
                : null,
        ).toMatchObject({ wake: true, body: 'wake safely' });

        const dispatch = findCliCommand(['agent', 'dispatch', 'resume']);
        expect(
            dispatch?.kind === 'remote'
                ? dispatch.parseParams([
                      '--project',
                      'project-1',
                      '--session',
                      'session-1',
                      '--terminal',
                      'terminal-1',
                      '--provider-session',
                      'provider-session-1',
                  ])
                : null,
        ).toEqual({
            projectId: 'project-1',
            sessionId: 'session-1',
            terminalId: 'terminal-1',
            providerSessionId: 'provider-session-1',
        });

        const steer = findCliCommand(['terminal', 'send']);
        expect(
            steer?.kind === 'remote'
                ? steer.parseParams([
                      '--terminal',
                      'terminal-1',
                      '--text',
                      'human input',
                      '--enter',
                  ])
                : null,
        ).toEqual({ terminalId: 'terminal-1', text: 'human input', enter: true });
    });
    /**
     * `--quiet` reads its IDs only after the request ran. A declared projection that does not match the result made a
     * mutation that already happened exit with `VALIDATION`, which invites a retry that repeats it.
     */
    it('projects a string ID from every declared quiet result', () => {
        const commands: readonly CliCommandDefinition[] = CLI_COMMANDS;
        const declared = commands.filter(
            (command): command is RemoteCommandDefinition =>
                command.kind === 'remote' &&
                (command.quietKey !== undefined || command.quietIdKey !== undefined),
        );
        expect(declared.map(({ path }) => path.join(' '))).toEqual(
            expect.arrayContaining([
                'agent delegate create',
                'agent dispatch start',
                'agent list',
                'agent message send',
                'bot board',
                'bot session create',
                'bot session archive',
                'bot task list',
                'terminal send',
            ]),
        );
        const broken = declared
            .filter(
                (command) =>
                    !hasQuietIds(
                        methods[command.method].result,
                        command.quietKey,
                        command.quietIdKey,
                    ),
            )
            .map(({ path }) => path.join(' '));
        expect(broken).toEqual([]);
    });
});

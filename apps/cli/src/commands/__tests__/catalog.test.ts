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
                'commander board',
                'commander session create',
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
     * mutation that already happened exit with `VALIDATION`, which invites a retry that repeats it. `agent list` is the
     * one known gap: an Endpoint's ID is its formatted reference, which a field cannot name (#1380).
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
                'agent message send',
                'commander board',
                'commander session create',
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
        expect(broken).toEqual(['agent list']);
    });
});

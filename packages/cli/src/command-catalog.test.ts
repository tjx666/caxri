import { describe, expect, it } from 'vitest';

import { CLI_COMMANDS, findCliCommand } from './command-catalog';

describe('CLI business command catalog', () => {
    it('registers every bounded business and diagnostics command', () => {
        const paths = CLI_COMMANDS.map(({ path }) => path.join(' '));

        expect(paths).toEqual(
            expect.arrayContaining([
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
                'agent message send',
                'agent message wait',
                'agent message check',
                'agent message reply',
                'agent message receipt',
                'agent message policy',
                'agent message policy-set',
            ]),
        );
    });

    it('parses scoped selectors and bounded diagnostic filters', () => {
        const session = findCliCommand(['session', 'show', 'Work', '--project', 'project-1']);
        const logs = findCliCommand([
            'logs',
            'query',
            '--process',
            'runtime',
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
                ? logs.parseParams(['--process', 'runtime', '--level', 'error', '--limit', '25'])
                : null,
        ).toEqual({ process: 'runtime', level: 'error', limit: 25 });

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
    });
});

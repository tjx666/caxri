import { describe, expect, it, vi } from 'vitest';

import { parseSshEffectiveTarget, resolveSshHostWindowKey } from '../resolve-destination';

/**
 * Trimmed `ssh -G` output: OpenSSH prints every effective option, one lowercase `keyword value` pair per line.
 */
function effectiveConfig(hostname: string, user: string, port: number): string {
    return [
        `host ${hostname}`,
        `user ${user}`,
        `hostname ${hostname}`,
        `port ${port}`,
        'addressfamily any',
        'identityfile ~/.ssh/id_ed25519',
        '',
    ].join('\n');
}

describe('parseSshEffectiveTarget', () => {
    it('reads user, hostname, and port', () => {
        expect(parseSshEffectiveTarget(effectiveConfig('203.0.113.7', 'dev', 2222))).toBe(
            'dev@203.0.113.7:2222',
        );
    });

    it.each(['', 'hostname box\nuser dev', 'hostname box\nuser dev\nport abc'])(
        'refuses incomplete output %j',
        (output) => {
            expect(parseSshEffectiveTarget(output)).toBeUndefined();
        },
    );
});

describe('resolveSshHostWindowKey', () => {
    it('gives two aliases of the same account one key', async () => {
        const run = vi.fn((arguments_: string[]) =>
            Promise.resolve(
                effectiveConfig(
                    arguments_.at(-1) === 'other-box' ? '198.51.100.4' : '203.0.113.7',
                    'dev',
                    22,
                ),
            ),
        );

        const work = await resolveSshHostWindowKey('work', { run });
        const workDirect = await resolveSshHostWindowKey('work-direct', { run });
        const other = await resolveSshHostWindowKey('other-box', { run });

        expect(work).toBe('dev@203.0.113.7:22');
        expect(workDirect).toBe(work);
        expect(other).not.toBe(work);
    });

    it('keeps different ports and users apart', async () => {
        const outputs: Record<string, string> = {
            'dev@box': effectiveConfig('box', 'dev', 22),
            'dev@box:2222': effectiveConfig('box', 'dev', 2222),
            'ops@box': effectiveConfig('box', 'ops', 22),
        };
        const keys = await Promise.all(
            Object.keys(outputs).map((destination) =>
                resolveSshHostWindowKey(destination, {
                    run: () => Promise.resolve(outputs[destination]),
                }),
            ),
        );

        expect(new Set(keys).size).toBe(3);
    });

    it('asks ssh -G with the same config file and destination argv a connection uses', async () => {
        const run = vi.fn(() => Promise.resolve(effectiveConfig('box', 'dev', 2222)));

        await resolveSshHostWindowKey('dev@box:2222', { configFile: '/tmp/lab/ssh_config', run });

        expect(run).toHaveBeenCalledWith([
            '-F',
            '/tmp/lab/ssh_config',
            '-G',
            '-p',
            '2222',
            '-l',
            'dev',
            '--',
            'box',
        ]);
    });

    it('falls back to the spelling-based key when ssh -G fails or prints nothing usable', async () => {
        await expect(
            resolveSshHostWindowKey('dev@box:22', {
                run: () => Promise.reject(new Error('ssh: not found')),
            }),
        ).resolves.toBe('dev@box:22');
        await expect(
            resolveSshHostWindowKey('work', { run: () => Promise.resolve('') }),
        ).resolves.toBe('@work:22');
    });

    it('refuses an invalid destination without running ssh', async () => {
        const run = vi.fn(() => Promise.resolve(''));

        await expect(resolveSshHostWindowKey('-oProxyCommand=sh', { run })).rejects.toThrow();
        expect(run).not.toHaveBeenCalled();
    });
});

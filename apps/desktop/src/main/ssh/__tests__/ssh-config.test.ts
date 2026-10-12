import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    listSshConfigHosts,
    MAX_RECENT_DESTINATIONS,
    RecentSshDestinations,
    tokenizeConfigLine,
} from '../ssh-config';
import { makeShortTemporaryDirectory } from './support/remote-fixtures';

describe('ssh config', () => {
    let home: string;
    let sshDirectory: string;

    beforeEach(async () => {
        home = await makeShortTemporaryDirectory('cfg');
        sshDirectory = join(home, '.ssh');
        await mkdir(join(sshDirectory, 'config.d'), { recursive: true });
    });

    afterEach(async () => {
        await rm(home, { force: true, recursive: true });
    });

    describe('tokenizeConfigLine', () => {
        it('splits keyword and arguments with OpenSSH rules', () => {
            expect(tokenizeConfigLine('  HostName example.com')).toEqual({
                arguments: ['example.com'],
                keyword: 'hostname',
            });
            expect(tokenizeConfigLine('Port=2222')).toEqual({
                arguments: ['2222'],
                keyword: 'port',
            });
            expect(tokenizeConfigLine('User = "first last" # comment')).toEqual({
                arguments: ['first last'],
                keyword: 'user',
            });
            expect(tokenizeConfigLine('Host a b')).toEqual({
                arguments: ['a', 'b'],
                keyword: 'host',
            });
            expect(tokenizeConfigLine('# comment')).toBeUndefined();
            expect(tokenizeConfigLine(' '.repeat(3))).toBeUndefined();
        });
    });

    describe('listSshConfigHosts', () => {
        it('lists concrete aliases across includes and skips patterns and Match blocks', async () => {
            await writeFile(
                join(sshDirectory, 'config'),
                [
                    'Include config.d/*',
                    'Host devbox dev-*',
                    '    HostName devbox.example.com',
                    '    User dev',
                    '    Port 2222',
                    'Host !blocked * other',
                    '    User other-user',
                    'Match host devbox',
                    '    User matched',
                    'Host devbox',
                    '    User later',
                    'Host bad;name',
                ].join('\n'),
            );
            await writeFile(
                join(sshDirectory, 'config.d', 'b-work'),
                'Host work\n  HostName work.example.com\n',
            );
            await writeFile(join(sshDirectory, 'config.d', 'a-lab'), 'Host lab\n  Port 2200\n');
            await writeFile(join(sshDirectory, 'config.d', '.hidden'), 'Host hidden\n');

            const hosts = await listSshConfigHosts({ homeDirectory: home });
            expect(hosts).toEqual([
                { alias: 'lab', port: 2200 },
                { alias: 'work', hostName: 'work.example.com' },
                { alias: 'devbox', hostName: 'devbox.example.com', port: 2222, user: 'dev' },
                { alias: 'other', user: 'other-user' },
            ]);
        });

        it('stops at include cycles', async () => {
            await writeFile(join(sshDirectory, 'config'), 'Include ~/.ssh/config\nHost one\n');
            expect(await listSshConfigHosts({ homeDirectory: home })).toEqual([{ alias: 'one' }]);
        });

        it('returns an empty list when the config is missing', async () => {
            expect(await listSshConfigHosts({ homeDirectory: join(home, 'missing') })).toEqual([]);
        });

        it('honours an explicit config path', async () => {
            const path = join(home, 'custom_config');
            await writeFile(path, 'Host custom\n  User me\n');
            expect(await listSshConfigHosts({ configPath: path, homeDirectory: home })).toEqual([
                { alias: 'custom', user: 'me' },
            ]);
        });
    });

    describe('RecentSshDestinations', () => {
        it('records most recent first, deduplicates, caps, and writes a private file', async () => {
            const recent = new RecentSshDestinations(join(home, 'state'));
            expect(await recent.list()).toEqual([]);
            await recent.record('one');
            await recent.record('dev@two:2222');
            expect(await recent.record('one')).toEqual(['one', 'dev@two:2222']);
            expect(await recent.list()).toEqual(['one', 'dev@two:2222']);
            expect((await stat(recent.path)).mode & 0o777).toBe(0o600);

            for (let index = 0; index < MAX_RECENT_DESTINATIONS + 5; index += 1)
                // eslint-disable-next-line no-await-in-loop -- order matters.
                await recent.record(`host${index}`);
            const listed = await recent.list();
            expect(listed).toHaveLength(MAX_RECENT_DESTINATIONS);
            expect(listed[0]).toBe(`host${MAX_RECENT_DESTINATIONS + 4}`);
        });

        it('refuses invalid destinations and ignores corrupt files', async () => {
            const recent = new RecentSshDestinations(home);
            await expect(recent.record('-oProxyCommand=x')).rejects.toThrow();
            await writeFile(recent.path, '{not json');
            expect(await recent.list()).toEqual([]);
            await writeFile(
                recent.path,
                JSON.stringify({ destinations: ['ok', 'ok', 'bad host', 3, '-x'] }),
            );
            expect(await recent.list()).toEqual(['ok']);
            await recent.record('next');
            expect(JSON.parse(await readFile(recent.path, 'utf8'))).toEqual({
                destinations: ['next', 'ok'],
            });
        });
    });
});

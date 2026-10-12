import { describe, expect, it } from 'vitest';

import { buildSshHostPickerRows, parseSshDestination, sshHostDetail } from '../ssh-destination';

const hosts = [
    { alias: 'devbox', hostName: 'devbox.example.com', user: 'dev', port: 2222 },
    { alias: 'build', hostName: 'build.example.com' },
    { alias: 'plain' },
];

describe('parseSshDestination', () => {
    it('accepts an alias or user@host and trims surrounding whitespace', () => {
        expect(parseSshDestination('  dev@devbox.example.com ')).toBe('dev@devbox.example.com');
        expect(parseSshDestination('devbox')).toBe('devbox');
    });

    it('refuses text OpenSSH would read as an option or that holds whitespace', () => {
        expect(parseSshDestination('-oProxyCommand=sh')).toBeUndefined();
        expect(parseSshDestination('dev box')).toBeUndefined();
        expect(parseSshDestination(' '.repeat(3))).toBeUndefined();
    });
});

describe('sshHostDetail', () => {
    it('describes where an alias really goes', () => {
        expect(sshHostDetail(hosts[0])).toBe('dev@devbox.example.com:2222');
        expect(sshHostDetail(hosts[1])).toBe('build.example.com');
    });

    it('says nothing when the entry adds nothing beyond its alias', () => {
        expect(sshHostDetail({ alias: 'plain' })).toBeUndefined();
        expect(sshHostDetail({ alias: 'same', hostName: 'same' })).toBeUndefined();
    });
});

describe('buildSshHostPickerRows', () => {
    it('lists recent destinations first, keeps their config detail, and does not repeat them under config hosts', () => {
        const rows = buildSshHostPickerRows({
            hosts,
            query: '',
            recent: ['devbox', 'devbox', 'ad-hoc'],
        });
        expect(rows.recent).toEqual([
            { destination: 'devbox', detail: 'dev@devbox.example.com:2222' },
            { destination: 'ad-hoc' },
        ]);
        expect(rows.hosts.map((row) => row.destination)).toEqual(['build', 'plain']);
        expect(rows.typed).toBeUndefined();
        expect(rows.isInvalid).toBe(false);
    });

    it('filters by destination or detail, case-insensitively, and offers the typed destination', () => {
        const rows = buildSshHostPickerRows({ hosts, query: 'EXAMPLE', recent: [] });
        expect(rows.hosts.map((row) => row.destination)).toEqual(['devbox', 'build']);
        expect(rows.typed).toEqual({ destination: 'EXAMPLE' });
    });

    it('does not offer the typed text again when it already names a listed row', () => {
        expect(buildSshHostPickerRows({ hosts, query: 'build', recent: [] }).typed).toBeUndefined();
    });

    it('flags text that can never be a destination', () => {
        const rows = buildSshHostPickerRows({ hosts, query: '-oFoo', recent: [] });
        expect(rows.isInvalid).toBe(true);
        expect(rows.typed).toBeUndefined();
    });
});

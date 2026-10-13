import { describe, expect, it } from 'vitest';

import {
    knownHostsNameOf,
    parseSshDestination,
    sshDestinationArguments,
    sshDestinationKey,
    sshHostWindowKey,
} from '../destination';

describe('parseSshDestination', () => {
    it.each([
        ['devbox', { host: 'devbox' }],
        ['dev@devbox', { host: 'devbox', user: 'dev' }],
        ['dev@devbox.example.com:2222', { host: 'devbox.example.com', port: 2222, user: 'dev' }],
        ['192.0.2.10:22', { host: '192.0.2.10', port: 22 }],
        ['[2001:db8::1]', { host: '2001:db8::1' }],
        ['root@[2001:db8::1]:2200', { host: '2001:db8::1', port: 2200, user: 'root' }],
        ['2001:db8::1', { host: '2001:db8::1' }],
        ['first.last@corp@bastion', { host: 'bastion', user: 'first.last@corp' }],
    ])('parses %s', (value, expected) => {
        expect(parseSshDestination(value)).toEqual({ raw: value, ...expected });
    });

    it.each([
        '',
        '-oProxyCommand=sh',
        'host name',
        'host;id',
        'host$(id)',
        "o'neil@host",
        'dev@',
        'host:0',
        'host:65536',
        'host:abc',
        '[2001:db8::1',
        '[2001:db8::1]x',
        '[nothex]',
        'host\u{7}',
    ])('refuses %j', (value) => {
        expect(() => parseSshDestination(value)).toThrow();
    });
});

describe('sshDestinationArguments', () => {
    it('separates port and user and ends options before the host', () => {
        expect(sshDestinationArguments(parseSshDestination('dev@devbox:2222'))).toEqual([
            '-p',
            '2222',
            '-l',
            'dev',
            '--',
            'devbox',
        ]);
        expect(sshDestinationArguments(parseSshDestination('devbox'))).toEqual(['--', 'devbox']);
    });
});

describe('sshDestinationKey', () => {
    it('is stable per destination and config file', () => {
        const destination = parseSshDestination('dev@devbox');
        expect(sshDestinationKey(destination)).toMatch(/^[0-9a-f]{12}$/u);
        expect(sshDestinationKey(destination)).toBe(
            sshDestinationKey(parseSshDestination('dev@devbox')),
        );
        expect(sshDestinationKey(destination, '/tmp/ssh_config')).not.toBe(
            sshDestinationKey(destination),
        );
        expect(sshDestinationKey(parseSshDestination('devbox'))).not.toBe(
            sshDestinationKey(destination),
        );
    });
});

describe('sshHostWindowKey', () => {
    it('treats an explicit default port as the same SSH Host', () => {
        expect(sshHostWindowKey(parseSshDestination('dev@devbox:22'))).toBe(
            sshHostWindowKey(parseSshDestination('dev@devbox')),
        );
        expect(sshHostWindowKey(parseSshDestination('dev@devbox:2222'))).not.toBe(
            sshHostWindowKey(parseSshDestination('dev@devbox')),
        );
        expect(sshHostWindowKey(parseSshDestination('devbox'))).not.toBe(
            sshHostWindowKey(parseSshDestination('dev@devbox')),
        );
    });
});

describe('knownHostsNameOf', () => {
    const nameOf = (destination: string) =>
        knownHostsNameOf(sshHostWindowKey(parseSshDestination(destination)));

    it('names the SSH Host the way known_hosts records it', () => {
        expect(nameOf('dev@devbox')).toBe('devbox');
        expect(nameOf('devbox:2222')).toBe('[devbox]:2222');
        expect(nameOf('root@[2001:db8::1]:2200')).toBe('[2001:db8::1]:2200');
        expect(knownHostsNameOf('devbox')).toBeUndefined();
    });
});

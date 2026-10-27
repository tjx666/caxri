import { describe, expect, it } from 'vitest';

import { parseLsofListeningSockets, parseLsofWorkingDirectories } from '../listening-ports';
import { previewTargetsForRoots } from '../targets';

const LISTENERS = [
    'p101',
    'cnode',
    'f20',
    'tIPv6',
    'n[::1]:5173',
    'f21',
    'tIPv4',
    'n127.0.0.1:5173',
    'p202',
    'cpython3',
    'f3',
    'tIPv4',
    'n*:8000',
    'f4',
    'tIPv6',
    'n*:8001',
    'p303',
    'csystemd',
    'f5',
    'tIPv4',
    'n0.0.0.0:22',
    'p404',
    'cbun',
    'f6',
    'tIPv4',
    'n127.0.0.1:3000',
].join('\n');

const DIRECTORIES = [
    'p101',
    'fcwd',
    'n/work/app',
    'p202',
    'fcwd',
    'n/work/app-worktree/api',
    'p303',
    'fcwd',
    'n/',
    'p404',
    'fcwd',
    'n/work/application',
].join('\n');

describe('listening ports', () => {
    it('maps wildcard binds to the loopback of their own family', () => {
        expect(parseLsofListeningSockets(LISTENERS)).toEqual([
            { host: '::1', pid: 101, port: 5173, processName: 'node' },
            { host: '127.0.0.1', pid: 101, port: 5173, processName: 'node' },
            { host: '127.0.0.1', pid: 202, port: 8000, processName: 'python3' },
            { host: '::1', pid: 202, port: 8001, processName: 'python3' },
            { host: '127.0.0.1', pid: 303, port: 22, processName: 'systemd' },
            { host: '127.0.0.1', pid: 404, port: 3000, processName: 'bun' },
        ]);
    });

    it('offers only processes working inside a Session directory, IPv4 first', () => {
        const listening = {
            sockets: parseLsofListeningSockets(LISTENERS),
            workingDirectories: parseLsofWorkingDirectories(DIRECTORIES),
        };
        expect(
            previewTargetsForRoots(listening, ['/work/app', '/work/app-worktree'], new Set()),
        ).toEqual([
            { host: '127.0.0.1', port: 5173, processName: 'node' },
            { host: '127.0.0.1', port: 8000, processName: 'python3' },
            { host: '::1', port: 8001, processName: 'python3' },
        ]);
    });

    it('never offers Server Core its own listeners', () => {
        const listening = {
            sockets: parseLsofListeningSockets(LISTENERS),
            workingDirectories: parseLsofWorkingDirectories(DIRECTORIES),
        };
        expect(previewTargetsForRoots(listening, ['/work/app'], new Set([101]))).toEqual([]);
    });
});

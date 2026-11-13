import { ProcessTable } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import {
    displayCommand,
    findOwningRoot,
    parseKeychainLogLine,
    parseKeychainLogMessage,
} from '../keychain-prompt-log';

describe('parseKeychainLogMessage', () => {
    it('reads the PID of a displayed prompt, even when the path holds parentheses', () => {
        expect(
            parseKeychainLogMessage(
                'displaying keychain prompt for /opt/tools (beta)/bin/node(58105); ACL: <AclValidationContext(action:65538)>',
            ),
        ).toEqual({ kind: 'shown', pid: 58105 });
    });

    it('maps each answer to its outcome', () => {
        expect(parseKeychainLogMessage("user approved 'allow' for /usr/bin/node(7)")).toEqual({
            kind: 'resolved',
            outcome: 'allowed',
            pid: 7,
        });
        expect(
            parseKeychainLogMessage("user approved 'always allow' for /a/Electron Helper(8)"),
        ).toEqual({ kind: 'resolved', outcome: 'alwaysAllowed', pid: 8 });
        expect(
            parseKeychainLogMessage(
                "user did not approve 'allow' for /usr/bin/node(9): CssmError: CSSM Exception: 225",
            ),
        ).toEqual({ kind: 'resolved', outcome: 'denied', pid: 9 });
    });

    it("ignores the category's other messages", () => {
        expect(parseKeychainLogMessage('client is valid, proceeding')).toBeUndefined();
        expect(
            parseKeychainLogMessage('Keychain query for process 58105 (UID 501)'),
        ).toBeUndefined();
    });
});

describe('parseKeychainLogLine', () => {
    it('reads the event message of an ndjson record and skips the text banner', () => {
        expect(
            parseKeychainLogLine('Filtering the log data using "process == ..."'),
        ).toBeUndefined();
        expect(parseKeychainLogLine('{not json')).toBeUndefined();
        expect(
            parseKeychainLogLine(
                JSON.stringify({ eventMessage: "user approved 'allow' for /usr/bin/node(7)" }),
            ),
        ).toEqual({ kind: 'resolved', outcome: 'allowed', pid: 7 });
    });
});

describe('findOwningRoot', () => {
    const table = new ProcessTable([
        { pid: 100, parentPid: 1, cpuPercent: 0, rssKb: 0 },
        { pid: 200, parentPid: 100, cpuPercent: 0, rssKb: 0 },
        { pid: 300, parentPid: 200, cpuPercent: 0, rssKb: 0 },
        { pid: 400, parentPid: 1, cpuPercent: 0, rssKb: 0 },
    ]);

    it('walks the parent chain up to the nearest owned root', () => {
        const roots = new Map([[100, 'session-a']]);

        expect(findOwningRoot(300, table, roots)).toBe('session-a');
        expect(findOwningRoot(100, table, roots)).toBe('session-a');
    });

    it('returns undefined for a process Caxri did not start', () => {
        expect(findOwningRoot(400, table, new Map([[100, 'session-a']]))).toBeUndefined();
        expect(findOwningRoot(999, table, new Map([[100, 'session-a']]))).toBeUndefined();
    });

    it('stops on a parent cycle', () => {
        const cyclic = new ProcessTable([
            { pid: 10, parentPid: 11, cpuPercent: 0, rssKb: 0 },
            { pid: 11, parentPid: 10, cpuPercent: 0, rssKb: 0 },
        ]);
        expect(findOwningRoot(10, cyclic, new Map([[100, 'x']]))).toBeUndefined();
    });
});

describe('displayCommand', () => {
    it('folds the home directory, collapses whitespace, and shortens a long line', () => {
        expect(displayCommand('node   /home/dev/app/cli.js  list', '/home/dev')).toBe(
            'node ~/app/cli.js list',
        );
        const long = displayCommand(`node ${'x'.repeat(400)}`, '/home/dev');
        expect(long).toHaveLength(240);
        expect(long.endsWith('…')).toBe(true);
    });
});

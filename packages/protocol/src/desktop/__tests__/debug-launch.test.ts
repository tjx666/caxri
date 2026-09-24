import { describe, expect, it } from 'vitest';

import {
    inheritedExecArgv,
    inspectExecArgv,
    logLevelEnvironment,
    resolveLogLevel,
} from '../debug-launch';

describe('resolveLogLevel', () => {
    it('records debug unless a process is told otherwise', () => {
        expect(resolveLogLevel({})).toBe('debug');
        expect(resolveLogLevel({ CAXRI_LOG_LEVEL: '' })).toBe('debug');
    });

    it('accepts a recognized level regardless of spacing or case', () => {
        expect(resolveLogLevel({ CAXRI_LOG_LEVEL: ' INFO ' })).toBe('info');
        expect(resolveLogLevel({ CAXRI_LOG_LEVEL: 'warn' })).toBe('warn');
    });

    it('keeps the default rather than silencing a process on an unrecognized level', () => {
        expect(resolveLogLevel({ CAXRI_LOG_LEVEL: 'verbose' })).toBe('debug');
        expect(resolveLogLevel({ CAXRI_LOG_LEVEL: 'off' })).toBe('debug');
    });
});

describe('logLevelEnvironment', () => {
    it('forwards an active override to a child process', () => {
        expect(logLevelEnvironment({ CAXRI_LOG_LEVEL: 'warn' })).toEqual({
            CAXRI_LOG_LEVEL: 'warn',
        });
    });

    it('stays empty when no override is set, so the child keeps its own default', () => {
        expect(logLevelEnvironment({})).toEqual({});
        expect(logLevelEnvironment({ CAXRI_LOG_LEVEL: '' })).toEqual({});
    });
});

describe('inspectExecArgv', () => {
    it('gives each Host its own port so all three can be attached at once', () => {
        expect(inspectExecArgv('server-core', {})).toEqual(['--inspect=9229']);
        expect(inspectExecArgv('extension-host', {})).toEqual(['--inspect=9230']);
        expect(inspectExecArgv('terminal-host', {})).toEqual(['--inspect=9231']);
    });

    it('treats an explicit 1 the same as leaving the variable unset', () => {
        expect(inspectExecArgv('extension-host', { CAXRI_INSPECT: '1' })).toEqual([
            '--inspect=9230',
        ]);
    });

    it('opens no port at all when a session asks for none', () => {
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: '0' })).toEqual([]);
        expect(inspectExecArgv('extension-host', { CAXRI_INSPECT: ' 0 ' })).toEqual([]);
    });

    it('moves the whole range when the variable carries a base port', () => {
        expect(inspectExecArgv('terminal-host', { CAXRI_INSPECT: '9500' })).toEqual([
            '--inspect=9502',
        ]);
    });

    it('keeps the default range when the base port is not a usable unprivileged port', () => {
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: '80' })).toEqual(['--inspect=9229']);
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: '70000' })).toEqual([
            '--inspect=9229',
        ]);
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: 'yes' })).toEqual([
            '--inspect=9229',
        ]);
    });

    it('never pauses a Host before it can answer its supervisor', () => {
        expect(inspectExecArgv('extension-host', {}).join(' ')).not.toContain('brk');
    });
});

describe('inheritedExecArgv', () => {
    it('drops only the parent inspector flags', () => {
        expect(
            inheritedExecArgv([
                '--inspect=9229',
                '--inspect',
                '--inspect-brk=9300',
                '--inspect-port=9400',
                '--enable-source-maps',
                '--max-old-space-size=4096',
            ]),
        ).toEqual(['--enable-source-maps', '--max-old-space-size=4096']);
    });
});

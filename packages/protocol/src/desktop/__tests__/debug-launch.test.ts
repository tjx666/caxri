import { describe, expect, it } from 'vitest';

import { inspectExecArgv, logLevelEnvironment, resolveLogLevel } from '../debug-launch';

describe('resolveLogLevel', () => {
    it('keeps the compiled-in default when nothing asks for an override', () => {
        expect(resolveLogLevel({ environment: {}, fallback: 'info' })).toBe('info');
        expect(resolveLogLevel({ environment: { CAXRI_LOG_LEVEL: '' }, fallback: 'info' })).toBe(
            'info',
        );
    });

    it('accepts a recognized level regardless of spacing or case', () => {
        expect(
            resolveLogLevel({ environment: { CAXRI_LOG_LEVEL: ' DEBUG ' }, fallback: 'info' }),
        ).toBe('debug');
        expect(
            resolveLogLevel({ environment: { CAXRI_LOG_LEVEL: 'warn' }, fallback: 'debug' }),
        ).toBe('warn');
    });

    it('falls back rather than silencing a process on an unrecognized level', () => {
        expect(
            resolveLogLevel({ environment: { CAXRI_LOG_LEVEL: 'verbose' }, fallback: 'info' }),
        ).toBe('info');
        expect(resolveLogLevel({ environment: { CAXRI_LOG_LEVEL: 'off' }, fallback: 'info' })).toBe(
            'info',
        );
    });
});

describe('logLevelEnvironment', () => {
    it('forwards an active override to a child process', () => {
        expect(logLevelEnvironment({ CAXRI_LOG_LEVEL: 'debug' })).toEqual({
            CAXRI_LOG_LEVEL: 'debug',
        });
    });

    it('stays empty when no override is set, so the child keeps its own default', () => {
        expect(logLevelEnvironment({})).toEqual({});
        expect(logLevelEnvironment({ CAXRI_LOG_LEVEL: '' })).toEqual({});
    });
});

describe('inspectExecArgv', () => {
    it('adds no inspector unless an operator asks for one', () => {
        expect(inspectExecArgv('server-core', {})).toEqual([]);
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: '0' })).toEqual([]);
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: '' })).toEqual([]);
    });

    it('gives each Host its own port so all three can be attached at once', () => {
        const environment = { CAXRI_INSPECT: '1' };
        expect(inspectExecArgv('server-core', environment)).toEqual(['--inspect=9229']);
        expect(inspectExecArgv('extension-host', environment)).toEqual(['--inspect=9230']);
        expect(inspectExecArgv('terminal-host', environment)).toEqual(['--inspect=9231']);
    });

    it('moves the whole range when the variable carries a base port', () => {
        expect(inspectExecArgv('terminal-host', { CAXRI_INSPECT: '9500' })).toEqual([
            '--inspect=9502',
        ]);
    });

    it('ignores a base port that is not a usable unprivileged port', () => {
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: '80' })).toEqual([]);
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: '70000' })).toEqual([]);
        expect(inspectExecArgv('server-core', { CAXRI_INSPECT: 'yes' })).toEqual([]);
    });

    it('never pauses a Host before it can answer its supervisor', () => {
        expect(inspectExecArgv('extension-host', { CAXRI_INSPECT: '1' }).join(' ')).not.toContain(
            'brk',
        );
    });
});

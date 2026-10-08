import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StructuredLogger } from '@caxri/system';
import { expect, it, vi } from 'vitest';

import {
    createTestTerminalExecution,
    createTestTerminalManager,
} from '../../../__tests__/support/terminal';
import { CaxriDatabase } from '../../db';
import type { TerminalExecutionPort } from '../index';

it('still removes later execution listeners on shutdown when an earlier remover throws', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-execution-listener-disposal-'));
    const database = new CaxriDatabase(join(directory, 'state.db'));
    const logger = new StructuredLogger(join(directory, 'logs'));
    const failure = new Error('event remover failed');
    const removedHostExit = vi.fn();
    const base = createTestTerminalExecution(logger);
    const execution = new Proxy(base, {
        get(target, property) {
            if (property === 'onEvent')
                return (listener: Parameters<TerminalExecutionPort['onEvent']>[0]) => {
                    const remove = target.onEvent(listener);
                    return () => {
                        remove();
                        throw failure;
                    };
                };
            if (property === 'onHostExit')
                return (listener: Parameters<TerminalExecutionPort['onHostExit']>[0]) => {
                    const remove = target.onHostExit(listener);
                    return () => {
                        remove();
                        removedHostExit();
                    };
                };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === 'function'
                ? (value as (...arguments_: unknown[]) => unknown).bind(target)
                : value;
        },
    });
    const manager = createTestTerminalManager(database, () => {}, logger, { execution });
    try {
        await expect(manager.shutdown('orderly')).rejects.toThrow(failure);
        expect(removedHostExit).toHaveBeenCalledTimes(1);
    } finally {
        database.close();
        await logger.flush();
        await rm(directory, { recursive: true, force: true });
    }
});

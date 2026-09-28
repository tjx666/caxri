import { describe, expect, it, vi } from 'vitest';

import { notifyListeners } from '../notify-listeners';

describe('notifyListeners', () => {
    it('delivers the value to every listener exactly once even when an earlier listener throws', () => {
        const calls: string[] = [];
        const first = vi.fn(() => {
            calls.push('first');
            throw new Error('boom');
        });
        const second = vi.fn(() => calls.push('second'));
        const third = vi.fn(() => calls.push('third'));
        const listeners = new Set([first, second, third]);
        const errors: unknown[] = [];

        notifyListeners(listeners, 'payload', (error) => errors.push(error));

        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
        expect(third).toHaveBeenCalledTimes(1);
        expect(calls).toEqual(['first', 'second', 'third']);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(Error);
    });

    it('never hands the delivered value to the error reporter', () => {
        const secretPayload = { transcript: 'do not leak me' };
        const thrownError = new Error('listener failed');
        const throwing = () => {
            throw thrownError;
        };
        const reported: unknown[] = [];

        notifyListeners([throwing], secretPayload, (...arguments_: unknown[]) => {
            reported.push(...arguments_);
        });

        expect(reported).toEqual([thrownError]);
    });

    it('reports one error per throwing listener without stopping the others', () => {
        const errors: unknown[] = [];
        const throwsA = () => {
            throw new Error('a');
        };
        const throwsB = () => {
            throw new Error('b');
        };
        const survives = vi.fn();

        notifyListeners([throwsA, throwsB, survives], 'event', (error) => errors.push(error));

        expect(survives).toHaveBeenCalledTimes(1);
        expect(errors.map((error) => (error as Error).message)).toEqual(['a', 'b']);
    });

    it('is a no-op when no error reporter is supplied', () => {
        const throwing = () => {
            throw new Error('unreported');
        };
        const survives = vi.fn();

        expect(() => notifyListeners([throwing, survives], 'event')).not.toThrow();
        expect(survives).toHaveBeenCalledTimes(1);
    });
});

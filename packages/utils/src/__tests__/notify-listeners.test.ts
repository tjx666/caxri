import { describe, expect, it, vi } from 'vitest';

import {
    disposeAll,
    disposeAllThenRethrow,
    notifyListeners,
    notifyListenersThenRethrow,
} from '../notify-listeners';

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

describe('notifyListenersThenRethrow', () => {
    it('delivers to every listener before rethrowing the first failure', () => {
        const firstError = new Error('first');
        const first = vi.fn(() => {
            throw firstError;
        });
        const second = vi.fn(() => {
            throw new Error('second');
        });
        const third = vi.fn();

        expect(() => notifyListenersThenRethrow(new Set([first, second, third]), 'value')).toThrow(
            firstError,
        );
        expect(third).toHaveBeenCalledExactlyOnceWith('value');
    });

    it('returns normally when every listener succeeds', () => {
        const listener = vi.fn();

        expect(() => notifyListenersThenRethrow([listener], 1)).not.toThrow();
        expect(listener).toHaveBeenCalledExactlyOnceWith(1);
    });
});

describe('disposeAll', () => {
    it('releases every disposable and teardown callback even when an earlier one throws', () => {
        const errors: unknown[] = [];
        const throwing = {
            dispose: vi.fn(() => {
                throw new Error('Attempted to dispose unknown listener');
            }),
        };
        const later = { dispose: vi.fn() };
        const teardown = vi.fn();

        disposeAll([throwing, later, teardown], (error) => errors.push(error));

        expect(throwing.dispose).toHaveBeenCalledTimes(1);
        expect(later.dispose).toHaveBeenCalledTimes(1);
        expect(teardown).toHaveBeenCalledTimes(1);
        expect(errors.map((error) => (error as Error).message)).toEqual([
            'Attempted to dispose unknown listener',
        ]);
    });

    it('swallows failures only when no error reporter is supplied', () => {
        const throwing = () => {
            throw new Error('unreported');
        };
        const later = vi.fn();

        expect(() => disposeAll([throwing, later])).not.toThrow();
        expect(later).toHaveBeenCalledTimes(1);
    });
});

describe('disposeAllThenRethrow', () => {
    it('releases every entry before rethrowing the first failure', () => {
        const firstError = new Error('first');
        const first = () => {
            throw firstError;
        };
        const second = {
            dispose: () => {
                throw new Error('second');
            },
        };
        const later = { dispose: vi.fn() };

        expect(() => disposeAllThenRethrow(new Set([first, second, later]))).toThrow(firstError);
        expect(later.dispose).toHaveBeenCalledTimes(1);
    });

    it('returns normally when every entry disposes cleanly', () => {
        const entry = { dispose: vi.fn() };

        expect(() => disposeAllThenRethrow([entry])).not.toThrow();
        expect(entry.dispose).toHaveBeenCalledTimes(1);
    });
});

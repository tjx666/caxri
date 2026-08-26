import { describe, expect, it } from 'vitest';

import type { E2EErrorEvent } from '../error-policy';
import { assertE2EErrorPolicy } from '../error-policy';

const rendererPageError = {
    source: 'renderer',
    event: 'pageerror',
    code: 'PAGE_ERROR',
} satisfies E2EErrorEvent;

describe('assertE2EErrorPolicy', () => {
    it('fails a passing workflow when an unexpected error was observed', () => {
        expect(() => assertE2EErrorPolicy([rendererPageError], [])).toThrow(
            'Unexpected E2E errors: renderer/pageerror/PAGE_ERROR x1',
        );
    });

    it('accepts only the exact declared source, event, code, and count', () => {
        expect(() =>
            assertE2EErrorPolicy([rendererPageError], [{ ...rendererPageError, count: 1 }]),
        ).not.toThrow();
        expect(() =>
            assertE2EErrorPolicy(
                [rendererPageError],
                [{ ...rendererPageError, code: 'CONSOLE_ERROR', count: 1 }],
            ),
        ).toThrow('Unexpected E2E errors: renderer/pageerror/PAGE_ERROR x1');
    });

    it('fails when an expected error was not consumed', () => {
        expect(() => assertE2EErrorPolicy([], [{ ...rendererPageError, count: 1 }])).toThrow(
            'Missing E2E errors: renderer/pageerror/PAGE_ERROR x1',
        );
    });

    it('rejects wildcard and duplicate allowances', () => {
        expect(() =>
            assertE2EErrorPolicy([], [{ ...rendererPageError, event: '*', count: 1 }]),
        ).toThrow('E2E error allowances must use exact non-empty values');
        expect(() =>
            assertE2EErrorPolicy(
                [],
                [
                    { ...rendererPageError, count: 1 },
                    { ...rendererPageError, count: 1 },
                ],
            ),
        ).toThrow('Duplicate E2E error allowance');
    });
});

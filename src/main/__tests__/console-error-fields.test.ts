import { describe, expect, it } from 'vitest';

import { consoleErrorLogFields } from '../console-error-fields';

describe('consoleErrorLogFields', () => {
    /**
     * Regression: the previous handler logged only `{ code: 'CONSOLE_ERROR' }`, which made the ErrorBoundary's mirrored
     * render error untriageable (no message, no source).
     */
    it('carries the console message and source location', () => {
        expect(
            consoleErrorLogFields({
                message: 'Renderer render error TypeError: boom',
                sourceId: 'http://localhost:5173/src/main.tsx',
                lineNumber: 42,
            }),
        ).toEqual({
            code: 'CONSOLE_ERROR',
            message: 'Renderer render error TypeError: boom',
            source: 'http://localhost:5173/src/main.tsx:42',
        });
    });

    it('truncates oversized messages and marks the cut', () => {
        const fields = consoleErrorLogFields({ message: 'x'.repeat(10_000) });
        expect((fields.message as string).length).toBeLessThan(4100);
        expect(fields.message).toMatch(/… \[truncated\]$/);
    });

    it('falls back when the source location is missing', () => {
        expect(consoleErrorLogFields({ message: 'boom' }).source).toBe('<unknown>:0');
    });
});

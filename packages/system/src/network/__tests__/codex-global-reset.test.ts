import { describe, expect, it, vi } from 'vitest';

import {
    CODEX_GLOBAL_RESET_FORECAST_URL,
    createCodexGlobalReset,
    parseCodexGlobalResetForecast,
} from '../codex-global-reset.js';

const CHECKED_AT = Date.parse('2026-01-02T03:00:00.000Z');

function forecast(overrides: Record<string, unknown> = {}, signal: Record<string, unknown> = {}) {
    return {
        last_reset_at: '2026-01-01T00:00:00.000Z',
        official_signal: {
            summary: 'Lands by midnight PST.',
            at: '2026-01-02T02:00:00.000Z',
            url: 'https://x.com/example/status/1',
            window: {
                target_kind: 'deadline',
                target_at: '2026-01-02T08:00:00.000Z',
            },
            ...signal,
        },
        ...overrides,
    };
}

function jsonResponse(body: unknown, status = 200): Response {
    return Response.json(body, {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

describe('parseCodexGlobalResetForecast', () => {
    it('reads a dated announcement as a scheduled reset', () => {
        expect(parseCodexGlobalResetForecast(forecast(), CHECKED_AT)).toEqual({
            state: 'scheduled',
            checkedAt: CHECKED_AT,
            targetAt: Date.parse('2026-01-02T08:00:00.000Z'),
            targetKind: 'deadline',
            announcedAt: Date.parse('2026-01-02T02:00:00.000Z'),
            quote: 'Lands by midnight PST.',
            postUrl: 'https://x.com/example/status/1',
        });
    });

    it('treats a target kind other than deadline as an exact time', () => {
        expect(
            parseCodexGlobalResetForecast(
                forecast({}, { window: { target_kind: 'at', target_at: '2026-01-02T08:00:00Z' } }),
                CHECKED_AT,
            ),
        ).toMatchObject({ state: 'scheduled', targetKind: 'exact' });
    });

    it('has nothing to count down to without a signal, a target time, or once the reset landed', () => {
        const none = { state: 'none', checkedAt: CHECKED_AT };
        expect(
            parseCodexGlobalResetForecast(forecast({ official_signal: null }), CHECKED_AT),
        ).toEqual(none);
        expect(parseCodexGlobalResetForecast(forecast({}, { window: null }), CHECKED_AT)).toEqual(
            none,
        );
        expect(
            parseCodexGlobalResetForecast(
                forecast({ last_reset_at: '2026-01-02T02:30:00.000Z' }),
                CHECKED_AT,
            ),
        ).toEqual(none);
        for (const url of [
            'javascript:alert(1)',
            'https://example.com/status/1',
            'ftp://x.com/a/status/1',
        ])
            expect(parseCodexGlobalResetForecast(forecast({}, { url }), CHECKED_AT)).toEqual(none);
    });

    it('rejects a body without the documented shape', () => {
        expect(parseCodexGlobalResetForecast([], CHECKED_AT)).toBeUndefined();
        expect(
            parseCodexGlobalResetForecast(forecast({ official_signal: 'soon' }), CHECKED_AT),
        ).toBeUndefined();
    });
});

describe('createCodexGlobalReset', () => {
    it('identifies itself, caches a reading, and shares it between callers', async () => {
        const fetch = vi.fn(() => Promise.resolve(jsonResponse(forecast())));
        let now = CHECKED_AT;
        const read = createCodexGlobalReset({
            fetch,
            userAgent: () => 'Caxri/test',
            now: () => now,
        });
        const [first, second] = await Promise.all([read(), read()]);
        expect(first).toEqual(second);
        expect(first.state).toBe('scheduled');
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]).toEqual([
            CODEX_GLOBAL_RESET_FORECAST_URL,
            {
                signal: expect.any(AbortSignal) as AbortSignal,
                headers: { 'User-Agent': 'Caxri/test', 'Accept': 'application/json' },
            },
        ]);
        now += 4 * 60_000;
        await read();
        expect(fetch).toHaveBeenCalledTimes(1);
        now += 2 * 60_000;
        await read();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('reports a closed failure reason and logs only its transitions', async () => {
        const write = vi.fn();
        let now = CHECKED_AT;
        let answer: () => Promise<Response> = () => Promise.reject(new Error('offline'));
        const read = createCodexGlobalReset({
            fetch: () => answer(),
            userAgent: () => 'Caxri/test',
            logger: () => ({ write }),
            now: () => now,
        });
        expect(await read()).toEqual({ state: 'unavailable', checkedAt: now, reason: 'network' });
        now += 2 * 60_000;
        await read();
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith('warn', 'external_status.codex_global_reset_failed', {
            fields: { reason: 'network' },
        });

        answer = () => Promise.resolve(jsonResponse({}, 503));
        now += 2 * 60_000;
        expect(await read()).toMatchObject({ state: 'unavailable', reason: 'http' });

        answer = () => Promise.resolve(new Response('<html>', { status: 200 }));
        now += 2 * 60_000;
        expect(await read()).toMatchObject({ state: 'unavailable', reason: 'invalidResponse' });

        answer = () => Promise.resolve(jsonResponse(forecast()));
        now += 2 * 60_000;
        expect(await read()).toMatchObject({ state: 'scheduled' });
        expect(write).toHaveBeenLastCalledWith(
            'info',
            'external_status.codex_global_reset_recovered',
            { fields: { previousReason: 'invalidResponse' } },
        );
    });
});

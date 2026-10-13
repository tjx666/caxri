import { methods } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    admitBenchmarkWindowRequest,
    isBenchmarkWindowEvent,
    isBenchmarkWindowMethod,
} from '../benchmark-window-policy';

function request(method: string) {
    return { protocolVersion: 1, id: 'request-1', method, params: {} };
}

describe('Benchmark window policy', () => {
    it('admits its own requests and refuses every write outside Benchmark', () => {
        const onDenied = vi.fn();
        for (const method of ['benchmark.start', 'benchmark.list', 'app.bootstrap', 'theme.get'])
            expect(() => admitBenchmarkWindowRequest(request(method), onDenied)).not.toThrow();
        for (const method of ['files.write', 'session.create', 'terminal.input', 'app.records'])
            expect(() => admitBenchmarkWindowRequest(request(method), onDenied)).toThrow(
                expect.objectContaining({ code: 'FORBIDDEN' }),
            );
        expect(onDenied.mock.calls).toEqual([
            ['files.write'],
            ['session.create'],
            ['terminal.input'],
            ['app.records'],
        ]);
    });

    it('admits every Benchmark request method the protocol declares', () => {
        const benchmarkMethods = Object.keys(methods).filter(
            (method) => method.startsWith('benchmark.') && method !== 'benchmark.open',
        );
        expect(benchmarkMethods.length).toBeGreaterThan(0);
        for (const method of benchmarkMethods) expect(isBenchmarkWindowMethod(method)).toBe(true);
    });

    it('receives durable events and its own transient events, never UI commands or PTY bytes', () => {
        expect(isBenchmarkWindowEvent({ cursor: 3, event: 'state.changed', payload: {} })).toBe(
            true,
        );
        expect(
            isBenchmarkWindowEvent({ event: 'benchmark.changed', payload: { runId: 'r' } }),
        ).toBe(true);
        expect(isBenchmarkWindowEvent({ event: 'host.connectionChanged', payload: {} })).toBe(true);
        expect(isBenchmarkWindowEvent({ event: 'command.execute', payload: {} })).toBe(false);
        expect(isBenchmarkWindowEvent({ event: 'terminal.output', payload: {} })).toBe(false);
        expect(isBenchmarkWindowEvent(null)).toBe(false);
    });
});

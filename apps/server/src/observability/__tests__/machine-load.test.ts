import { describe, expect, it, vi } from 'vitest';

import { MachineLoadMonitor } from '../machine-load';

function monitor(samples: number[]) {
    let clock = 0;
    const write = vi.fn<(level: string, event: string, record: unknown) => void>();
    const load = new MachineLoadMonitor({ now: () => clock, sample: () => samples.shift() ?? 0 });
    const advance = () => {
        clock += 5_000;
    };
    return { advance, load, write };
}

describe('MachineLoadMonitor', () => {
    it('reports an idle machine until the process attaches a logger', () => {
        const { load } = monitor([4]);
        expect(load.isLoaded()).toBe(false);
    });

    it('enters at one runnable thread per core, holds above the exit bound, and logs each transition', () => {
        const { advance, load, write } = monitor([0.5, 1.2, 0.9, 1.6, 0.6]);
        load.attach({ write } as never);

        expect(load.isLoaded()).toBe(false);
        advance();
        expect(load.isLoaded()).toBe(true);
        expect(load.shouldDefer('project-status-poll')).toBe(true);
        expect(load.shouldDefer('project-status-poll')).toBe(true);
        expect(load.shouldDefer('delivery-watch')).toBe(true);
        advance();
        expect(load.isLoaded()).toBe(true);
        advance();
        expect(load.isLoaded()).toBe(true);
        advance();
        expect(load.isLoaded()).toBe(false);

        expect(write.mock.calls.map((call) => call[2])).toEqual([
            { fields: { state: 'loaded', loadPerCore: 1.2 } },
            {
                durationMs: 15_000,
                fields: {
                    state: 'normal',
                    loadPerCore: 0.6,
                    peakLoadPerCore: 1.6,
                    deferred: 'project-status-poll=2,delivery-watch=1',
                },
            },
        ]);
    });

    it('lets one round of a source through after two minutes of deferring it', () => {
        let clock = 0;
        const load = new MachineLoadMonitor({ now: () => clock, sample: () => 2 });
        load.attach({ write: vi.fn() } as never);

        expect(load.shouldDefer('delivery-watch')).toBe(true);
        clock = 119_000;
        expect(load.shouldDefer('delivery-watch')).toBe(true);
        clock = 120_000;
        expect(load.shouldDefer('delivery-watch')).toBe(false);
        expect(load.shouldDefer('delivery-watch')).toBe(true);
    });

    it('samples at most once per interval', () => {
        const sample = vi.fn(() => 2);
        const load = new MachineLoadMonitor({ now: () => 0, sample });
        load.attach({ write: vi.fn() } as never);
        load.isLoaded();
        load.isLoaded();
        expect(sample).toHaveBeenCalledOnce();
    });
});

import type { ITerminalAddon, Terminal } from '@xterm/xterm';
import { describe, expect, it } from 'vitest';

import type { GpuIncidentBudget } from '../../gpu/gpu-incident-budget';
import { createGpuIncidentBudget } from '../../gpu/gpu-incident-budget';
import type { TerminalRendererStatus } from '../terminal-renderer';
import { TerminalRendererController } from '../terminal-renderer';
import { FakeWebglAddon } from './terminal-renderer-test-helpers';

function createPane(budget: GpuIncidentBudget, options: { failLoad?: boolean } = {}) {
    const statuses: TerminalRendererStatus[] = [];
    let addon: FakeWebglAddon | undefined;
    const host = {
        loadAddon(candidate: ITerminalAddon): void {
            if (options.failLoad) throw new Error('WebGL load failed');
            candidate.activate({} as Terminal);
        },
    };
    const controller = new TerminalRendererController(
        host,
        () => {},
        (status) => statuses.push(status),
        {
            createWebglAddon: () => (addon = new FakeWebglAddon()),
            policy: budget,
            random: () => 0.5,
        },
    );
    return { controller, loseContext: () => addon?.loseContext(), statuses };
}

describe('Terminal WebGL live-context count', () => {
    it('reports the count that existed when a context was lost', () => {
        const budget = createGpuIncidentBudget({ probeWebgl2: () => true });
        const first = createPane(budget);
        const second = createPane(budget);
        first.controller.setPreference('on');
        second.controller.setPreference('on');
        // A load that throws never held a context, so it must not inflate the count.
        createPane(budget, { failLoad: true }).controller.setPreference('on');
        expect(budget.liveWebglContextCount()).toBe(2);
        expect(second.statuses.at(-1)).toMatchObject({ liveWebglContextCount: 2 });

        first.loseContext();
        // Every record of the loss transition carries the pre-release count, including the lost context itself.
        expect(first.statuses.at(-1)).toMatchObject({
            liveWebglContextCount: 2,
            trigger: 'webgl-context-loss',
        });
        expect(budget.liveWebglContextCount()).toBe(1);

        second.controller.recoverFromGpuProcessLoss();
        expect(second.statuses.at(-1)).toMatchObject({
            liveWebglContextCount: 1,
            trigger: 'gpu-process-recovery',
        });
        expect(budget.liveWebglContextCount()).toBe(0);

        // A manual retry resets the incident budget, never the measurement.
        expect(first.controller.retryFromUser()).toBe(true);
        expect(budget.liveWebglContextCount()).toBe(1);
        first.controller.suspend();
        expect(budget.liveWebglContextCount()).toBe(0);
        first.controller.dispose();
        second.controller.dispose();
        expect(budget.liveWebglContextCount()).toBe(0);
    });
});

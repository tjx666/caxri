import { expect, it } from 'vitest';

import { createHarness } from './suspension.fixture';

it('can suspend after maintenance finishes without a durable user-task completion callback', async () => {
    const harness = createHarness({
        settings: {
            'terminal.idleSuspension.enabled': true,
            'terminal.idleSuspension.afterMinutes': 1,
        },
    });
    harness.service.start();
    harness.service.observeLaunch('terminal-a');
    harness.service.observeLifecycle({
        phase: 'turnStarted',
        terminalId: 'terminal-a',
        activity: 'maintenance',
    });
    harness.service.observeLifecycle({
        phase: 'turnFailed',
        terminalId: 'terminal-a',
        activity: 'maintenance',
    });
    harness.advance(60_000);
    expect(await harness.service.sweep()).toEqual(['terminal-a']);
    await harness.service.close();
});

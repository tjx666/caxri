import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import type { App } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { AppQuitTriggerOptions } from '../app-quit-triggers';
import { installBeforeQuitTrigger, installSignalQuitTriggers } from '../app-quit-triggers';

type Listener = (...arguments_: unknown[]) => void;

/**
 * Minimal stand-in for the `on` surface of Electron's `app` and Node's `process`.
 */
function createListeners() {
    const listeners = new Map<string, Listener[]>();
    return {
        emit(event: string, ...arguments_: unknown[]) {
            const eventListeners = listeners.get(event) ?? [];
            for (const listener of eventListeners) listener(...arguments_);
        },
        on(event: string, listener: Listener) {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
    };
}

function harness(overrides: Partial<AppQuitTriggerOptions> = {}) {
    const appEvents = createListeners();
    const app = { exit: vi.fn(), on: appEvents.on.bind(appEvents) } as unknown as Pick<
        App,
        'exit' | 'on'
    >;
    const write = vi.fn();
    const options: AppQuitTriggerOptions = {
        app,
        isQuitStarted: () => false,
        logger: () => ({ write }) as unknown as StructuredLogger,
        requestAppQuit: vi.fn().mockResolvedValue('kept-running'),
        ...overrides,
    };
    return { app, appEvents, options, write };
}

describe('installBeforeQuitTrigger', () => {
    it('prevents the default quit and asks the quit handler without a signal', () => {
        const { appEvents, options, write } = harness();
        installBeforeQuitTrigger(options);
        const event = { preventDefault: vi.fn() };

        appEvents.emit('before-quit', event);

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(options.requestAppQuit).toHaveBeenCalledWith();
        expect(write).toHaveBeenCalledWith('info', logEventCatalog.app.quitRequested);
    });

    it('only prevents the default once a quit has started', () => {
        const { appEvents, options } = harness({ isQuitStarted: () => true });
        installBeforeQuitTrigger(options);
        const event = { preventDefault: vi.fn() };

        appEvents.emit('before-quit', event);

        expect(event.preventDefault).toHaveBeenCalledTimes(1);
        expect(options.requestAppQuit).not.toHaveBeenCalled();
    });
});

describe('installSignalQuitTriggers', () => {
    it.each(['SIGINT', 'SIGTERM'] as const)(
        'routes %s to the quit handler as a signal',
        (signal) => {
            const { options, write } = harness({ isQuitStarted: () => true });
            const target = createListeners();
            installSignalQuitTriggers(options, target as unknown as Pick<NodeJS.Process, 'on'>);

            target.emit(signal);

            expect(options.requestAppQuit).toHaveBeenCalledWith(signal);
            expect(write).toHaveBeenCalledWith('info', logEventCatalog.app.quitRequested, {
                fields: { trigger: signal, isQuitStarted: true },
            });
        },
    );

    it('exits when the quit handler rejects', async () => {
        const { app, options } = harness({
            requestAppQuit: vi.fn().mockRejectedValue(new Error('teardown failed')),
        });
        const target = createListeners();
        installSignalQuitTriggers(options, target as unknown as Pick<NodeJS.Process, 'on'>);

        target.emit('SIGTERM');

        await vi.waitFor(() => expect(app.exit).toHaveBeenCalledWith(0));
    });
});

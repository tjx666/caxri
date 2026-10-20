import { SingleFlight } from '@caxri/system';
import { describe, expect, it } from 'vitest';

import {
    authoritativeGitMutation,
    currentGitRequestSignal,
    sharedGitRequest,
    withGitRequestSignal,
} from '../request-signal';

describe('Git request cancellation', () => {
    it('cancels one waiter without aborting a shared producer or its other waiter', async () => {
        const controller = new AbortController();
        const producer = Promise.withResolvers<string>();
        const requests = new SingleFlight<string, string>();
        let producerSignal: AbortSignal | undefined;
        const load = () =>
            requests.run('summary', () => {
                producerSignal = currentGitRequestSignal();
                return producer.promise;
            });

        const canceled = withGitRequestSignal(controller.signal, () => sharedGitRequest(load));
        const joined = sharedGitRequest(load);
        controller.abort();

        await expect(canceled).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(producerSignal).toBeUndefined();
        producer.resolve('current');
        await expect(joined).resolves.toBe('current');
    });

    it('honors cancellation before a mutation boundary and detaches once mutation starts', async () => {
        const canceledController = new AbortController();
        canceledController.abort();
        await expect(
            withGitRequestSignal(canceledController.signal, () =>
                authoritativeGitMutation(() => Promise.resolve('unreachable')),
            ),
        ).rejects.toMatchObject({ code: 'CANCELLED' });

        const runningController = new AbortController();
        const mutation = Promise.withResolvers<string>();
        let mutationSignal: AbortSignal | undefined;
        const running = withGitRequestSignal(runningController.signal, () =>
            authoritativeGitMutation(() => {
                mutationSignal = currentGitRequestSignal();
                return mutation.promise;
            }),
        );
        runningController.abort();
        mutation.resolve('completed');

        await expect(running).resolves.toBe('completed');
        expect(mutationSignal).toBeUndefined();
    });
});

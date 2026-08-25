import { describe, expect, it } from 'vitest';

import { SingleFlight } from '../../single-flight';
import { currentGitRequestSignal, sharedGitRequest, withGitRequestSignal } from '../request-signal';

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

        await expect(canceled).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(producerSignal).toBeUndefined();
        producer.resolve('current');
        await expect(joined).resolves.toBe('current');
    });
});

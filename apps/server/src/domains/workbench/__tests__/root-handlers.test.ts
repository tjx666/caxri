import { describe, expect, it, vi } from 'vitest';

import { createWorkbenchRootHandlers } from '../root-handlers';
import type { WorkbenchRootService } from '../roots';

type Validate = (parameters: { sessionId?: string }) => Promise<null>;

function setup() {
    const validate = vi.fn<(sessionId?: string) => Promise<void>>(() => Promise.resolve());
    const handlers = createWorkbenchRootHandlers({ validate } as unknown as WorkbenchRootService);
    const request = handlers['session.validateWorkbenchRoots'] as unknown as Validate;
    return { request, validate };
}

describe('session.validateWorkbenchRoots', () => {
    it('shares one all-Session sweep between back-to-back focus requests', async () => {
        const { request, validate } = setup();

        await Promise.all([request({}), request({})]);
        await request({});

        expect(validate).toHaveBeenCalledTimes(1);
        expect(validate).toHaveBeenCalledWith();
    });

    it('validates a named Session every time, outside the shared sweep', async () => {
        const { request, validate } = setup();

        await request({});
        await request({ sessionId: 'session-a' });
        await request({ sessionId: 'session-a' });

        expect(validate.mock.calls).toEqual([[], ['session-a'], ['session-a']]);
    });

    it('gives each handler set its own sweep', async () => {
        const first = setup();
        const second = setup();

        await first.request({});
        await second.request({});

        expect(first.validate).toHaveBeenCalledTimes(1);
        expect(second.validate).toHaveBeenCalledTimes(1);
    });
});

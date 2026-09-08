import type * as Caxri from 'caxri';
import { vi } from 'vitest';

/**
 * Supply the same pure utility export injected by the real Extension Host.
 */
vi.mock('caxri', async (importOriginal) => {
    const api = await importOriginal<typeof Caxri>();
    // eslint-disable-next-line caxri/architecture-boundaries -- The test fixture supplies the utility injected by the Server-owned Extension Host.
    const { isGlobMatch } = await import('@caxri/utils');
    return { ...api, isGlobMatch };
});

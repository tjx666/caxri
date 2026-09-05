import { describe, expect, it } from 'vitest';

import { shallowestProjectPath } from '../shallowest-project-path';

describe('shallowestProjectPath', () => {
    it('prefers the shallowest match and breaks ties by path order', () => {
        expect(
            shallowestProjectPath('/root', [
                '/root/z/packages',
                '/root/a/b/packages',
                '/root/b/packages',
            ]),
        ).toBe('/root/b/packages');
        expect(shallowestProjectPath('/root', [])).toBeUndefined();
    });
});

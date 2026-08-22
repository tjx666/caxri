import { describe, expect, it } from 'vitest';

import { assertExtensionBundleContract } from '../extension-bundle-contract';

describe('assertExtensionBundleContract', () => {
    it('accepts a public ESM-only bundle', () => {
        expect(() =>
            assertExtensionBundleContract(
                'import caxri, { TreeItem } from "caxri"; export { caxri, TreeItem };',
                'publisher.extension',
            ),
        ).not.toThrow();
    });

    it.each([
        ['outside-host stub', 'const leak = "CAXRI_API_OUTSIDE_EXTENSION_HOST";'],
        ['protocol import', 'const leak = "@caxri/protocol";'],
        ['Runtime import', 'const leak = "/src/runtime/private.js";'],
        ['Electron import', 'import "electron/main";'],
    ])('rejects bundled implementation leak %s', (_name, statement) =>
        expect(() =>
            assertExtensionBundleContract(
                `import caxri from "caxri"; ${statement}`,
                'publisher.extension',
            ),
        ).toThrow(),
    );
});

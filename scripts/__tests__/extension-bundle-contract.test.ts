import { describe, expect, it } from 'vitest';

import {
    assertExtensionBundleContract,
    assertProductExtensionBundleContract,
} from '../extension-bundle-contract';

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
        ['Runtime import', 'const leak = "/apps/server/src/runtime/private.js";'],
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

describe('assertProductExtensionBundleContract', () => {
    it('accepts a production bundle whose only import is the public caxri API', () => {
        expect(() =>
            assertProductExtensionBundleContract(
                'import caxri, { TreeItem } from "caxri"; export { caxri, TreeItem };',
                'caxri.product',
            ),
        ).not.toThrow();
    });

    it.each([
        ['Node builtin', 'import process from "node:process";'],
        ['bare Node builtin', 'import { join } from "path";'],
        ['Electron', 'import { app } from "electron";'],
        ['protocol package', 'import { viewCatalogSnapshotSchema } from "@caxri/protocol";'],
        ['Desktop source', 'import { resolve } from "../../apps/server/src/host/paths";'],
        ['Renderer alias', 'import { useMemo } from "@/hooks/use-memo";'],
        ['third-party package', 'import debounce from "lodash/debounce";'],
        ['dynamic Node import', 'const fs = import("node:fs");'],
        ['require Node builtin', 'const fs = require("fs");'],
    ])('rejects %s from a production bundle', (_name, statement) =>
        expect(() =>
            assertProductExtensionBundleContract(
                `import caxri from "caxri"; ${statement}`,
                'caxri.product',
            ),
        ).toThrow(),
    );

    it('keeps the test-only fixture contract separate from the production boundary', () => {
        expect(() =>
            assertExtensionBundleContract(
                'import process from "node:process"; import caxri from "caxri";',
                'caxri.fixture',
            ),
        ).not.toThrow();
    });
});

import { describe, expect, it } from 'vitest';

import { verifyBundleSource } from './verify-bundle';

const validBundle = `#!/usr/bin/env node
require("node:fs");
name: caxri-cli
Start with live introspection
`;

describe('standalone CLI bundle verification', () => {
    it('accepts a self-contained Node bundle with the embedded skill', () => {
        expect(() => verifyBundleSource(validBundle)).not.toThrow();
        expect(() => verifyBundleSource(`${validBundle}\nrequire("zlib");`)).not.toThrow();
    });

    it('rejects a missing shebang and external imports', () => {
        expect(() => verifyBundleSource(validBundle.slice(validBundle.indexOf('\n') + 1))).toThrow(
            'missing its Node shebang',
        );
        expect(() => verifyBundleSource(`${validBundle}\nrequire("external-package");`)).toThrow(
            'external imports: external-package',
        );
        expect(() => verifyBundleSource(`${validBundle}\nrequire2("./impl/format");`)).toThrow(
            'external imports: ./impl/format',
        );
    });

    it.each(['better-sqlite3', 'electron', 'node-pty'])(
        'rejects the forbidden runtime marker %s',
        (marker) => {
            expect(() => verifyBundleSource(`${validBundle}\n${marker}`)).toThrow(
                `forbidden runtime marker: ${marker}`,
            );
        },
    );

    it.each(['name: caxri-cli', 'Start with live introspection'])(
        'requires the bundled skill marker %s',
        (marker) => {
            expect(() => verifyBundleSource(validBundle.replace(marker, ''))).toThrow(
                `missing bundled skill marker: ${marker}`,
            );
        },
    );
});

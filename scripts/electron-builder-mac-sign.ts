/**
 * Electron-builder `mac.sign` hook. electron-builder resolves the configured identity before calling this hook, and it
 * only accepts identities that `security find-identity -v` reports as trusted, which a self-signed release certificate
 * never is. The package config therefore keeps the ad-hoc identity (`-`) so resolution succeeds, and this hook swaps in
 * `CAXRI_MAC_SIGNING_IDENTITY` when the release workflow imported one. `codesign` itself signs with an untrusted
 * identity, and the resulting designated requirement pins the certificate leaf instead of the cdhash, so macOS privacy
 * grants (Accessibility, Screen Recording) survive app updates. See RELEASING.md#release-signing-certificate.
 *
 * Node loads this file directly (electron-builder runs under Node, which strips the types), so it imports only erasable
 * TypeScript syntax.
 */
import process from 'node:process';

import type { SignOptions } from '@electron/osx-sign';
import { signAsync } from '@electron/osx-sign';

export async function sign(options: SignOptions): Promise<void> {
    const identity = process.env.CAXRI_MAC_SIGNING_IDENTITY?.trim();
    if (!identity) {
        await signAsync(options);
        return;
    }
    const { optionsForFile } = options;
    await signAsync({
        ...options,
        identity,
        identityValidation: false,
        // Apple's timestamp service rejects certificates it did not issue ("The timestamp service is not available").
        optionsForFile: (filePath) => ({ ...optionsForFile?.(filePath), timestamp: 'none' }),
    });
}

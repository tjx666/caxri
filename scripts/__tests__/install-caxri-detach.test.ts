import { describe, expect, it } from 'vitest';

import { detachedInstallPlist, finishedInstallJobs } from '../install-caxri-detach';

describe('install-caxri --detach', () => {
    it('runs the install once from launchd, reopening Caxri, with the caller PATH', () => {
        const plist = detachedInstallPlist({
            installArguments: ['--tag', 'v0.0.7', '--relaunch'],
            label: 'dev.caxri.install.1',
            logPath: '/tmp/caxri-install.log',
            path: '/opt/homebrew/bin:/usr/bin',
            repoRoot: '/work/caxri & co',
            runtime: '/usr/local/bin/bun',
        });
        expect(plist).toContain(
            '<array><string>/usr/local/bin/bun</string><string>/work/caxri &amp; co/scripts/install-caxri.ts</string><string>--tag</string><string>v0.0.7</string><string>--relaunch</string></array>',
        );
        expect(plist).toContain('<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>');
        // A job that launchd restarted would reinstall and reopen Caxri in a loop.
        expect(plist).toContain('<key>KeepAlive</key><false/>');
        expect(plist).toContain('<key>LaunchOnlyOnce</key><true/>');
    });

    it('unloads only earlier install jobs that have exited', () => {
        const list = [
            'PID\tStatus\tLabel',
            '-\t0\tdev.caxri.install.1',
            '4242\t0\tdev.caxri.install.2',
            '-\t0\tcom.example.other',
        ].join('\n');
        expect(finishedInstallJobs(list)).toEqual(['dev.caxri.install.1']);
    });
});

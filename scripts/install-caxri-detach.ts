/**
 * Runs `install-caxri` as a one-shot launchd job so it outlives the Caxri it replaces.
 *
 * An Agent running inside the installed Caxri is a descendant of that app, and quitting Caxri ends its Session together
 * with everything the Session started: a foreground install, a `nohup` background job, and even a `setsid` one all died
 * with SIGTERM at "Quitting the running Caxri…", leaving the old version installed. A job that launchd starts has no
 * Caxri ancestor, so it survives the quit, installs, and reopens Caxri. A finished job stays loaded but inert (it never
 * restarts); the next detached install unloads it, since a job that unloads itself would die before reporting a
 * failure.
 */

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { execFileAsync } from './exec';

/**
 * Where the detached run writes its output, since it has no terminal.
 */
export const DETACHED_INSTALL_LOG = join(tmpdir(), 'caxri-install.log');

const JOB_LABEL_PREFIX = 'dev.caxri.install.';

interface DetachedInstallJob {
    /**
     * Arguments for the detached `install-caxri` run, with `--detach` removed and `--relaunch` added.
     */
    installArguments: string[];
    label: string;
    logPath: string;
    /**
     * `PATH` for the job: launchd's default lacks Homebrew, where `gh` lives.
     */
    path: string;
    repoRoot: string;
    runtime: string;
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

/**
 * Builds the property list for a one-shot user launchd job: it runs once at load and is never restarted.
 */
export function detachedInstallPlist(job: DetachedInstallJob): string {
    const string = (value: string) => `<string>${escapeXml(value)}</string>`;
    const programArguments = [
        job.runtime,
        join(job.repoRoot, 'scripts', 'install-caxri.ts'),
        ...job.installArguments,
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(job.label)}
  <key>ProgramArguments</key>
  <array>${programArguments.map(string).join('')}</array>
  <key>WorkingDirectory</key>${string(job.repoRoot)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${string(job.path)}
  </dict>
  <key>StandardOutPath</key>${string(job.logPath)}
  <key>StandardErrorPath</key>${string(job.logPath)}
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>LaunchOnlyOnce</key><true/>
</dict>
</plist>
`;
}

/**
 * Labels of earlier detached install jobs that have exited; `launchctl list` prints `-` as the PID of a job that is
 * loaded but not running.
 */
export function finishedInstallJobs(launchctlList: string): string[] {
    return launchctlList
        .matchAll(/^-\s+\S+\s+(dev\.caxri\.install\.\S+)$/gmu)
        .map(([, label]) => label)
        .toArray();
}

/**
 * Loads the detached install job and returns its label; the install runs as soon as launchd loads it.
 */
export async function startDetachedInstall(
    repoRoot: string,
    installArguments: string[],
): Promise<string> {
    if (!process.getuid) throw new Error('A detached install needs a POSIX user id.');
    const domain = `gui/${process.getuid()}`;
    const { stdout: loadedJobs } = await execFileAsync('launchctl', ['list']);
    for (const finished of finishedInstallJobs(loadedJobs)) {
        // eslint-disable-next-line no-await-in-loop -- at most a few leftovers, unloaded in order
        await execFileAsync('launchctl', ['bootout', `${domain}/${finished}`]);
    }
    const label = `${JOB_LABEL_PREFIX}${Date.now()}`;
    const plistPath = join(tmpdir(), `${label}.plist`);
    await writeFile(
        plistPath,
        detachedInstallPlist({
            installArguments: [...installArguments, '--relaunch'],
            label,
            logPath: DETACHED_INSTALL_LOG,
            path: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
            repoRoot,
            runtime: process.execPath,
        }),
    );
    await writeFile(DETACHED_INSTALL_LOG, '');
    await execFileAsync('launchctl', ['bootstrap', domain, plistPath]);
    return label;
}

/**
 * Reopens Caxri after a detached install, whether or not the install succeeded, since the detached run has no user at
 * hand to reopen it.
 */
export async function reopenCaxri(installPath: string): Promise<void> {
    await execFileAsync('open', [installPath]);
}

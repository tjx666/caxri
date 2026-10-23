import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * GLOSSARY.md names the feature "SSH Host" and lists Remote, Remote Server, Remote SSH, and Remote Environment as
 * aliases to avoid. This guard keeps the retired SSH Host spellings from returning in protocol, Main, Renderer, Server
 * code, living docs, and skills. It is intentionally a narrow denylist, not a ban on the word "remote".
 *
 * Out of scope on purpose, so they never need an entry here: Git remotes (`git remote`, `remoteHost`, `remoteBranch`),
 * remote debugging (`remoteDebugging*`), and transport-accurate words that describe the machine on the far end of the
 * SSH connection: `remotePort`, `remotePid`, `remoteShellCommand`, `RemoteCommand`, `RemoteForward`, the remote layer
 * artifact (`RemoteLayer*`, `RemoteTarget`, `remoteLayersRoot`, `build:remote-layers`), and the remote Server process
 * (`killRemoteServer`, `LaunchedRemoteServer`).
 */

const SCANNED_ROOTS = [
    'apps/desktop/src',
    'apps/server/src',
    'packages/protocol/src',
    'docs',
    'scripts',
    '.agents/skills',
    'GLOSSARY.md',
];

/**
 * Files whose text may legitimately keep a retired spelling: this guard itself, the coordinator-owned debt ledger, and
 * ADRs, which record decisions as they were written.
 */
const ALLOWED_FILES = new Set([
    'scripts/__tests__/ssh-host-vocabulary.test.ts',
    'docs/architecture-debt.md',
]);
const ALLOWED_PREFIXES = ['docs/adr/'];

/**
 * Retired spellings of SSH Host concepts. Each pattern is matched against file contents and against repository paths.
 */
const RETIRED_SPELLINGS: ReadonlyArray<{ pattern: RegExp; why: string }> = [
    {
        pattern: /remote[-_]?environment/iu,
        why: 'the SSH Host window registry is SshHostEnvironment',
    },
    { pattern: /remote[-_]ssh/iu, why: 'the feature is "SSH Host"; log events are ssh_host.*' },
    {
        pattern:
            /['"`]remote\.(?:hosts|connect|reconnect|retryNow|cancel|sshConfig|stopServer|askpass)/u,
        why: 'SSH Host methods and commands live under sshHost.*',
    },
    {
        pattern:
            /\bRemote(?:Host|Setup|Probe|Script|SeedConfig|Install|Transport|Failure|Askpass|ConnectionPhase|StateUpdate|StatePatch|RendererRoute|WindowMenu)[A-Za-z]*/u,
        why: 'SSH Host types are named SshHost*',
    },
    { pattern: /\bRemoteServerSupervisor/u, why: 'the supervisor is SshHostServerSupervisor' },
    { pattern: /\bREMOTE_PROFILE_IN_USE/u, why: 'the marker is SSH_HOST_PROFILE_IN_USE_MARKER' },
    { pattern: /\b(?:isRemote|useIsRemote)\b/u, why: 'the Environment predicate is isSshHost' },
];

const TEXT_FILE = /\.(?:md|mdx|ts|tsx|mts|cts|json|jsonc|yml|yaml)$/u;

function listRepoFiles(): string[] {
    const output = execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...SCANNED_ROOTS],
        {
            cwd: posix.resolve(import.meta.dirname, '../..'),
            encoding: 'utf8',
            maxBuffer: 64 * 1024 * 1024,
        },
    );
    return output
        .split('\0')
        .filter(Boolean)
        .filter(
            (path) =>
                !ALLOWED_FILES.has(path) &&
                ALLOWED_PREFIXES.every((prefix) => !path.startsWith(prefix)),
        );
}

describe('SSH Host vocabulary', () => {
    const root = posix.resolve(import.meta.dirname, '../..');
    const files = listRepoFiles();

    it('scans a plausible number of files', () => {
        expect(files.length).toBeGreaterThan(500);
    });

    it('keeps retired SSH Host spellings out of repository paths', () => {
        const offenders = files.flatMap((path) =>
            RETIRED_SPELLINGS.filter(({ pattern }) => pattern.test(path)).map(
                ({ why }) => `${path}: ${why}`,
            ),
        );
        expect(offenders).toEqual([]);
    });

    it('keeps retired SSH Host spellings out of file contents', () => {
        const offenders: string[] = [];
        for (const path of files) {
            if (!TEXT_FILE.test(path)) continue;
            const lines = readFileSync(posix.join(root, path), 'utf8').split('\n');
            lines.forEach((line, index) => {
                for (const { pattern, why } of RETIRED_SPELLINGS) {
                    if (pattern.test(line)) offenders.push(`${path}:${index + 1}: ${why}`);
                }
            });
        }
        expect(offenders).toEqual([]);
    });
});

import type { BigIntStats } from 'node:fs';

/**
 * The identity of a file as the filesystem sees it, for code that must decide whether the bytes behind a path are still
 * the same ones it looked at earlier.
 *
 * Two callers need this and had grown their own near-identical joins: the Claude metadata cache decides whether a
 * `sessions/*.json` entry has to be re-read, and the Git discard boundary binds destructive consent to the untracked
 * files the user saw named in the prompt. Their requirement is the same one, detect any replacement or rewrite, so they
 * share the definition rather than each having a field list that drifts.
 *
 * `mtimeNs` and `ctimeNs` are the nanosecond fields, not the millisecond ones: Claude Code rewrites a metadata file's
 * `status` inside a single millisecond, and that field drives the sidebar attention cue, so a millisecond-resolution
 * key would publish stale state. `dev` and `ino` catch a path repointed at a different file, `size` and `mode` catch
 * changes a coarse clock could otherwise hide.
 *
 * Callers pass their own `stat` result because only they know whether a symlink should be followed: the metadata cache
 * uses `stat`, the Git boundary `lstat`, and resolving the link would let a replaced symlink keep an old identity. The
 * result is an opaque string, meaningful only when compared against another from this same function.
 */
export function fileIdentity(stats: BigIntStats): string {
    return [stats.dev, stats.ino, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].join('\0');
}

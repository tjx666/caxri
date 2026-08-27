import type { GitCommit } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

/**
 * NUL-delimited field layout shared by every commit-metadata read (`git log -z`, `git show -s -z`): sha, author name,
 * author email, authored-at, parents, decorations, subject, body.
 */
export const COMMIT_FORMAT = '%H%x00%an%x00%ae%x00%at%x00%P%x00%D%x00%s%x00%b%x00';

/**
 * Parses fixed-width NUL fields emitted by `git log -z`, including non-ASCII subjects and multi-line bodies (a commit
 * message can never contain NUL, so the body is one ordinary field).
 */
export function parseCommitLog(output: string): GitCommit[] {
    const fields = output.split('\0');
    const commits: GitCommit[] = [];
    let index = 0;
    while (index < fields.length) {
        const rawSha = fields[index];
        if (!rawSha) break;
        const sha = rawSha.replace(/^\n+/, '');
        index += 1;
        const author = fields[index++];
        const authorEmail = fields[index++] ?? '';
        const authoredAt = fields[index++];
        const parents = fields[index++] ?? '';
        const decorations = fields[index++] ?? '';
        const subject = fields[index++] ?? '';
        const body = fields[index++] ?? '';
        const terminator = fields[index++];
        if (terminator !== '' || !/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(authoredAt))
            throw new CaxriError('GIT', 'Git returned malformed commit history');
        commits.push({
            sha,
            shortSha: sha.slice(0, 7),
            subject: subject.slice(0, 4_096),
            body: body.trim().slice(0, 16_384),
            author: author.slice(0, 1_024),
            authorEmail: authorEmail.slice(0, 1_024),
            authoredAt: Number(authoredAt) * 1_000,
            decorations: decorations
                .split(', ')
                .map((value) => value.trim())
                .filter(Boolean)
                .slice(0, 50)
                .map((value) => value.slice(0, 1_024)),
            parents: parents.split(' ').filter(Boolean).slice(0, 64),
        });
    }
    return commits;
}

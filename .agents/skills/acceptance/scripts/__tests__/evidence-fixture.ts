import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Test-only helpers for the round files `finalize` requires but that carry no behavior under test: the reviewer-facing
 * evidence description and this round's `proposal.md` note. Keeping them here stops every fixture from inventing its
 * own Chinese sentence, and keeps the real contract in one place when it changes.
 */
export function citeEvidence(path: string, description?: string) {
    return { description: description ?? `用于核对本用例观察结果的证据文件：${path}`, path };
}

export function citeEvidenceList(paths: string[]) {
    return paths.map((path) => citeEvidence(path));
}

export async function writeProposal(
    directory: string,
    note = '本轮交付终端布局修复，请重点看终端视口是否仍有背景色条。',
) {
    await writeFile(join(directory, 'proposal.md'), `${note}\n`, 'utf8');
}

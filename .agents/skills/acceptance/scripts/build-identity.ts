import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BUILD_COMMIT_PATTERN =
    /process(?:\$[\w$]+)?\.env\.CAXRI_GIT_COMMIT\s*=\s*["']([0-9a-f]{7,64})["']/iu;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;

/**
 * Prevents an Acceptance round from exercising a bundle built from an older commit. File mtimes cannot detect a commit
 * made after an otherwise current build, so the frozen report head is compared with the commit that electron-vite
 * stamps into Main.
 */
export function assertAcceptanceBuildCommit(input: {
    builtMainSource: string;
    reportCommit: string;
}): void {
    const builtCommit = BUILD_COMMIT_PATTERN.exec(input.builtMainSource)?.[1]?.toLowerCase();
    const reportCommit = input.reportCommit.trim().toLowerCase();
    if (!builtCommit || !COMMIT_PATTERN.test(reportCommit)) {
        throw new Error('Could not read a usable commit from the Acceptance build or report');
    }
    if (!reportCommit.startsWith(builtCommit)) {
        throw new Error(
            `Build commit ${builtCommit} does not match Acceptance report commit ${reportCommit.slice(0, 7)}; run \`bun run build\` before Acceptance`,
        );
    }
}

/**
 * Main's build output is a small `index.js` bootstrap that dynamically imports a hashed `main-*.js` chunk, and the
 * commit stamp lives in that chunk. Reading only `index.js` found no stamp, so every Acceptance launch failed the
 * commit check; reading every emitted script keeps the check independent of how Main is split.
 */
export async function readBuiltMainSource(directory: string): Promise<string> {
    const names = (await readdir(directory))
        .filter((name) => name.endsWith('.js'))
        .toSorted((left, right) => left.localeCompare(right));
    const sources = await Promise.all(names.map((name) => readFile(join(directory, name), 'utf8')));
    return sources.join('\n');
}

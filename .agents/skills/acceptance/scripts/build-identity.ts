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

/**
 * Diff-scoped guardrails `check.ts`'s lint gate wires in whenever the changed-file set touches the file types they own:
 * the source-size ratchet (`scripts/source-size-ratchet.ts`) for code, and `documentation-check.ts` for Markdown. Both
 * gates read the changed-file diff themselves through Git rather than taking a file list, so this only decides
 * _whether_ to invoke each one from the bucket split `check.ts` already computes for its own autofix pipeline. Kept out
 * of `check.ts` itself to keep that file under its own source-size ratchet.
 */

export interface ChangedFileGuardrailOptions {
    hasChangedMarkdown: boolean;
    hasChangedSourceCode: boolean;
    root: string;
    runCapture: (command: string, arguments_: string[], cwd: string) => Promise<string>;
}

/**
 * Runs the in-scope guardrails and returns their names, in run order, for the caller's own check summary.
 * documentation-check always runs unscoped (not `--files`) even though only Markdown changed: its `--files` mode
 * mis-resolves an absolute path (a bug in a file this skill does not own), and an unscoped run is cheap while also
 * catching README-index gaps a scoped run would miss.
 */
export async function runChangedFileGuardrails(
    options: ChangedFileGuardrailOptions,
): Promise<string[]> {
    const ran: string[] = [];
    if (options.hasChangedSourceCode) {
        await options.runCapture('bun', ['run', 'source-size-ratchet'], options.root);
        ran.push('source-size-ratchet');
    }
    if (options.hasChangedMarkdown) {
        await options.runCapture('bun', ['run', 'docs-check'], options.root);
        ran.push('docs-check');
    }
    return ran;
}

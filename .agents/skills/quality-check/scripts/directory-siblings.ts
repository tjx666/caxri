import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/**
 * Folders whose presence `caxri/feature-directory-structure` reads when it judges a file beside them.
 */
const CLASSIFICATION_DIRECTORIES = new Set(['__tests__', 'hooks', 'utils']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/**
 * Directories whose file set a diff changed, and so may flip a directory-sensitive lint verdict on files the diff did
 * not touch: the parent of every added or removed path, plus the grandparent when that parent is a classification
 * folder (`hooks/`, `__tests__/`, `utils/`). Adding `settings/hooks/` once left two untouched `use-*.ts` siblings
 * failing `caxri/feature-directory-structure`; the focused check never linted them and `main`'s hosted lint went red.
 */
export function compositionChangedDirectories(paths: readonly string[]): string[] {
    const directories = new Set<string>();
    for (const path of paths) {
        const parent = dirname(path);
        directories.add(parent);
        if (CLASSIFICATION_DIRECTORIES.has(basename(parent))) directories.add(dirname(parent));
    }
    return [...directories].toSorted((a, b) => a.localeCompare(b));
}

/**
 * Untouched TypeScript files directly inside `directories`, which the directory-sensitive rule must re-judge. Missing
 * directories (everything in them was removed) contribute nothing.
 */
export async function untouchedDirectorySiblings(
    root: string,
    directories: readonly string[],
    touched: readonly string[],
): Promise<string[]> {
    const skip = new Set(touched);
    const siblings = await Promise.all(
        directories.map(async (directory) => {
            try {
                const entries = await readdir(join(root, directory), { withFileTypes: true });
                return entries
                    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)))
                    .map((entry) => (directory === '.' ? entry.name : `${directory}/${entry.name}`))
                    .filter((file) => !skip.has(file));
            } catch {
                return [];
            }
        }),
    );
    return [...new Set(siblings.flat())].toSorted((a, b) => a.localeCompare(b));
}

type Capture = (executable: string, arguments_: string[], root: string) => Promise<string>;
type Run = (root: string, executable: string, arguments_: string[]) => Promise<void>;

/**
 * Lints the untouched siblings of every directory whose file set changed against `base`. It runs without the ESLint
 * content cache on purpose: an unchanged file's cached verdict predates the new sibling directory.
 */
export async function lintDirectorySiblings(options: {
    base: string;
    files: readonly string[];
    removedFiles: readonly string[];
    root: string;
    capture: Capture;
    run: Run;
}): Promise<number> {
    const { base, files, removedFiles, root, capture, run } = options;
    const existedAtBase =
        files.length > 0
            ? new Set(
                  (
                      await capture(
                          'git',
                          ['ls-tree', '-r', '--name-only', '-z', base, '--', ...files],
                          root,
                      )
                  )
                      .split('\0')
                      .filter(Boolean),
              )
            : new Set<string>();
    const added = files.filter((file) => !existedAtBase.has(file));
    const directories = compositionChangedDirectories([...added, ...removedFiles]);
    const siblings = await untouchedDirectorySiblings(root, directories, files);
    if (siblings.length > 0)
        await run(root, 'eslint', ['--no-warn-ignored', '--max-warnings=0', ...siblings]);
    return siblings.length;
}

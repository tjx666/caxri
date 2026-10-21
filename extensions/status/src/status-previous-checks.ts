import type { ProjectStatusPreviousChecks } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import { projectStatusStateLabel } from './status-labels';
import { stateIcons, stateTones } from './status-presentation';

type ChangedFile = NonNullable<ProjectStatusPreviousChecks['changedFiles']>[number];

/**
 * Prose files whose edits rarely change a check's outcome. `.txt` is deliberately absent: `requirements.txt` and
 * `CMakeLists.txt` are build inputs.
 */
const PROSE_EXTENSIONS = /\.(?:md|mdx|markdown|rst)$/i;
/**
 * Images count only under a `docs/` directory, where they are screenshots and diagrams. Code or config there (a docs
 * site's `.ts` or `.json`) can still fail a build, so it does not count.
 */
const DOCS_ASSET_PATH = /(?:^|\/)docs\/.*\.(?:png|jpe?g|gif|svg|webp)$/i;
/**
 * GitHub's compare endpoint lists at most this many files, so a list this long may be truncated and cannot prove the
 * unlisted files were documentation too.
 *
 * @see https://docs.github.com/en/rest/commits/commits#compare-two-commits
 */
const COMPARE_FILE_LIMIT = 300;

export function isDocumentationPath(path: string): boolean {
    return PROSE_EXTENSIONS.test(path) || DOCS_ASSET_PATH.test(path);
}

function commitsBackLabel(count: number): string {
    return count === 1 ? '1 commit back' : `${count} commits back`;
}

/**
 * The commit row's trailing text says only where the commit sits. Its icon already carries the verdict, the same way
 * each check row's does, and repeating `passed` there truncated the commit title the row exists to show.
 */
function positionLabel(count: number): string {
    return count === 1 ? 'previous' : commitsBackLabel(count);
}

function filesLabel(count: number): string {
    return count === 1 ? '1 file' : `${count} files`;
}

function lineDelta(files: ReadonlyArray<Pick<ChangedFile, 'additions' | 'deletions'>>): string {
    const additions = files.reduce((sum, file) => sum + file.additions, 0);
    const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
    return `+${additions} −${deletions}`;
}

/**
 * The changed-files summary's trailing text: `docs only` when every file is documentation, because that is the case the
 * row exists to answer at a glance, otherwise the line delta so the size of the change still reads without expanding.
 */
export function changedFilesDescription(files: readonly ChangedFile[]): string {
    return files.length < COMPARE_FILE_LIMIT &&
        files.every((file) => isDocumentationPath(file.path))
        ? 'docs only'
        : lineDelta(files);
}

/**
 * Each file row spends its trailing slot on the line delta rather than the directory: in a narrow sidebar a long
 * directory squeezed the file name down to a few characters, while `+12 −3` stays short. The full path is the hover
 * title.
 */
function fileRow(id: string, file: ChangedFile): StatusNode {
    const name = file.path.slice(file.path.lastIndexOf('/') + 1);
    return item(id, name, {
        icon: 'file',
        description: lineDelta([file]),
        accessibilityLabel: `${file.path}, ${lineDelta([file])}`,
        tooltip: { title: file.path },
    });
}

/**
 * The previous verdict under a pull request whose head checks are unfinished or failing: the newest earlier commit
 * whose checks settled, named by its title rather than a hash and labeled `Previous commit:` so the row never reads as
 * one of the head's checks, then what changed from it to the head. Together they answer whether the head's pending
 * result is likely to repeat that verdict.
 */
export function previousChecksNode(
    prefix: string,
    previous: ProjectStatusPreviousChecks,
): StatusNode {
    const stateLabel = projectStatusStateLabel(previous.state);
    const files = previous.changedFiles;
    const children = files
        ? [
              item(`${prefix}:previous-checks:files`, `${filesLabel(files.length)} changed since`, {
                  icon: 'file-diff',
                  description: files.length > 0 ? changedFilesDescription(files) : undefined,
                  children: files.map((file, index) =>
                      fileRow(`${prefix}:previous-checks:file:${index}`, file),
                  ),
                  collapsibleState:
                      files.length > 0
                          ? TreeItemCollapsibleState.Collapsed
                          : TreeItemCollapsibleState.None,
              }),
          ]
        : [];
    return item(`${prefix}:previous-checks`, `Previous commit: ${previous.title}`, {
        icon: stateIcons[previous.state],
        description: positionLabel(previous.commitsBefore),
        accessibilityLabel: `Previous commit ${previous.title}, checks ${stateLabel}, ${commitsBackLabel(previous.commitsBefore)}`,
        url: previous.url,
        tooltip: {
            title: previous.title,
            description: 'The newest earlier commit whose checks finished.',
            badge: { label: stateLabel, tone: stateTones[previous.state] },
            rows: [
                { label: 'position', value: commitsBackLabel(previous.commitsBefore) },
                ...(files && files.length > 0
                    ? [
                          {
                              label: 'since',
                              value: `${filesLabel(files.length)}, ${changedFilesDescription(files)}`,
                          },
                      ]
                    : []),
            ],
        },
        children,
        collapsibleState:
            children.length > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None,
    });
}

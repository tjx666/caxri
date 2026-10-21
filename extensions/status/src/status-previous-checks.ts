import type { ProjectStatusPreviousChecks } from 'caxri';
import { TreeItemCollapsibleState } from 'caxri';

import type { StatusNode } from './status-item';
import { item } from './status-item';
import { projectStatusStateLabel } from './status-labels';
import { stateIcons, stateTones } from './status-presentation';

type ChangedFile = NonNullable<ProjectStatusPreviousChecks['changedFiles']>[number];

/**
 * Prose files whose edits rarely change a check's outcome. A path under a `docs/` directory counts whatever its
 * extension, so a screenshot added to the docs still reads as documentation.
 */
const DOCUMENTATION_EXTENSIONS = /\.(?:md|mdx|markdown|rst|txt)$/i;

export function isDocumentationPath(path: string): boolean {
    return DOCUMENTATION_EXTENSIONS.test(path) || /(?:^|\/)docs\//.test(path);
}

function commitsBackLabel(count: number): string {
    return count === 1 ? '1 commit back' : `${count} commits back`;
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
    return files.every((file) => isDocumentationPath(file.path)) ? 'docs only' : lineDelta(files);
}

function fileRow(id: string, file: ChangedFile): StatusNode {
    const slash = file.path.lastIndexOf('/');
    const name = file.path.slice(slash + 1);
    const directory = slash > 0 ? file.path.slice(0, slash) : undefined;
    return item(id, name, {
        icon: 'file',
        description: directory,
        accessibilityLabel: `${file.path}, ${lineDelta([file])}`,
        tooltip: { title: file.path, rows: [{ label: 'lines', value: lineDelta([file]) }] },
    });
}

/**
 * The previous verdict under a pull request whose head checks are unfinished or failing: the newest earlier commit
 * whose checks settled, named by its title rather than a hash, then what changed from it to the head. Together they
 * answer whether the head's pending result is likely to repeat that verdict.
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
    return item(`${prefix}:previous-checks`, previous.title, {
        icon: stateIcons[previous.state],
        description: `${stateLabel} · ${commitsBackLabel(previous.commitsBefore)}`,
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

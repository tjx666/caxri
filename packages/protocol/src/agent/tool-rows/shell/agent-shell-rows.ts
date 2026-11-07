import { pathBasename } from '@caxri/utils';

import { describeShellCommand } from '../../agent-shell-command.js';
import type { AgentToolPresentation } from '../../agent-tool-presentation.js';
import type { AgentShellPullRequestAction } from './agent-shell-cli.js';
import { describeShellScript } from './agent-shell-script.js';
import { readableShellCommand } from './agent-shell-title.js';

const EXPLORE_KINDS: ReadonlySet<AgentToolPresentation['kind']> = new Set([
    'list',
    'read',
    'search',
]);

const PULL_REQUEST_LABELS: Readonly<Record<AgentShellPullRequestAction, string>> = {
    check: 'Checked PR',
    close: 'Closed PR',
    comment: 'Commented on PR',
    create: 'Opened PR',
    edit: 'Updated PR',
    list: 'Listed PRs',
    merge: 'Merged PR',
};

/**
 * A shell command's row: the action it performs, else the inline script or file write it opens with, else `Ran` and the
 * command line.
 */
export function describeShellRow(command: string): AgentToolPresentation {
    const action = describeShellAction(command);
    if (action) return action;
    const step = describeShellScript(command);
    if (!step) {
        return {
            kind: 'command',
            label: 'Ran',
            subject: readableShellCommand(command),
            isCodeSubject: true,
        };
    }
    const rest = step.rest === undefined ? undefined : describeShellRow(step.rest);
    // A file written for the command after it (an issue body for `gh issue create --body-file`) is that step's input. A
    // read, search, or listing after it only checks the result, so the write stays the title.
    if (
        rest &&
        step.kind === 'write' &&
        !(rest.kind === 'command' && rest.label === 'Ran') &&
        !EXPLORE_KINDS.has(rest.kind)
    )
        return rest;
    // Two scripts in a row (`python3 - <<'EOF'` twice) read as one; the title shows what follows the last.
    if (step.kind === 'script' && rest?.label === step.label) return rest;
    const then = step.rest === undefined ? undefined : `→ ${readableShellCommand(step.rest)}`;
    if (step.kind === 'write') {
        const name = pathBasename(step.path);
        return {
            kind: 'write',
            label: 'Wrote',
            subject: then ? `${name} ${then}` : name,
            isCodeSubject: true,
        };
    }
    if (then) return { kind: 'command', label: step.label, subject: then, isCodeSubject: true };
    return {
        kind: 'command',
        label: step.label,
        ...(step.note !== undefined && { subject: step.note }),
        isCodeSubject: false,
    };
}

/**
 * A shell command that reads, searches, or lists files reads as that action (`Read app.ts`), the way the Codex app
 * shows exploration, and a test run, commit, push, or pull request step names that step; see `describeShellCommand`.
 */
function describeShellAction(command: string): AgentToolPresentation | null {
    const action = describeShellCommand(command);
    switch (action?.kind) {
        case 'read': {
            const [only] = action.paths;
            const skill = action.paths.length === 1 && describeSkillRead(only);
            if (skill) return skill;
            return {
                kind: 'read',
                label: 'Read',
                subject: action.paths.map((path) => pathBasename(path)).join(', '),
                isCodeSubject: true,
                ...(action.paths.length === 1 && only && { path: only }),
            };
        }
        case 'search': {
            return {
                kind: 'search',
                label: action.isFileNames ? 'Found files' : 'Searched',
                subject: action.path
                    ? `${action.pattern} in ${pathBasename(action.path)}`
                    : action.pattern,
                isCodeSubject: true,
            };
        }
        case 'list': {
            const path = action.path === '.' ? undefined : action.path;
            return path
                ? {
                      kind: 'list',
                      label: 'Listed',
                      subject: pathBasename(path),
                      isCodeSubject: true,
                  }
                : { kind: 'list', label: 'Listed files', isCodeSubject: true };
        }
        case 'test': {
            // Go's `./...` pattern names a package tree; its last segment alone would read `...`.
            const targets = action.targets.map((target) =>
                target.endsWith('...') ? target : pathBasename(target),
            );
            return {
                kind: 'test',
                label: 'Ran tests',
                subject:
                    targets.length > 0 ? targets.join(', ') : readableShellCommand(action.command),
                isCodeSubject: true,
            };
        }
        case 'commit': {
            return {
                kind: 'commit',
                label: action.isPushed ? 'Committed and pushed' : 'Committed',
                ...(action.message !== undefined && { subject: action.message }),
                isCodeSubject: false,
            };
        }
        case 'push': {
            return {
                kind: 'push',
                label: 'Pushed',
                ...(action.branch !== undefined && { subject: action.branch }),
                isCodeSubject: true,
            };
        }
        case 'pullRequest': {
            return {
                kind: 'pullRequest',
                label: PULL_REQUEST_LABELS[action.action],
                ...(action.subject !== undefined && { subject: action.subject }),
                isCodeSubject: false,
            };
        }
        case 'cli': {
            return {
                kind: 'command',
                label: action.label,
                ...(action.subject !== undefined && { subject: action.subject }),
                isCodeSubject: action.isCodeSubject,
            };
        }
        case undefined: {
            return null;
        }
    }
}

/**
 * Reading a skill's `skills/<name>/SKILL.md` is how Codex uses a skill, so the row names the skill with the skill
 * glyph, as Claude Code's `Skill` tool does, instead of `Read SKILL.md`. The path stays so the row still opens the
 * file. A `SKILL.md` outside a `skills` folder is an ordinary read.
 */
export function describeSkillRead(path: string): AgentToolPresentation | undefined {
    const segments = path.split(/[\\/]+/u);
    const [folder, name, file] = segments.slice(-3);
    if (file !== 'SKILL.md' || !name || folder !== 'skills') return undefined;
    return { kind: 'skill', label: 'Used skill', subject: name, isCodeSubject: true, path };
}

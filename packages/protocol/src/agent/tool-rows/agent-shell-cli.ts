/**
 * What a command of a CLI an Agent drives every day did: GitHub's `gh`, Vercel's `vc`, and LobeHub's `lh`. Their
 * command lines are long (`cd ~/code/app && gh api repos/owner/app/pulls/12/comments --jq ...`) while what they did
 * fits in a few words (`Called GitHub API owner/app/pulls/12/comments`), so a row names the action and its target.
 *
 * Labels are the English source strings of the shared tool label table (`TOOL_LABEL_KEYS`), so every Client shows them
 * in the reader's language.
 */
export type AgentShellCliAction =
    | { kind: 'pullRequest'; action: AgentShellPullRequestAction; subject?: string }
    | { kind: 'cli'; label: AgentShellCliLabel; subject?: string; isCodeSubject: boolean };

export type AgentShellPullRequestAction =
    'check' | 'close' | 'comment' | 'create' | 'edit' | 'list' | 'merge';

/**
 * Every label a recognized CLI step reads as. `Ran` is the fallback for a `gh`, `vc`, or `lh` command this module does
 * not name, which still drops the `cd <dir> &&` before it.
 */
export type AgentShellCliLabel =
    | 'Ran'
    | 'Viewed issue'
    | 'Listed issues'
    | 'Opened issue'
    | 'Updated issue'
    | 'Commented on issue'
    | 'Closed issue'
    | 'Reopened issue'
    | 'Checked CI run'
    | 'Read CI logs'
    | 'Listed CI runs'
    | 'Reran CI'
    | 'Canceled CI run'
    | 'Started workflow'
    | 'Called GitHub API'
    | 'Inspected deployment'
    | 'Read deployment logs'
    | 'Listed deployments'
    | 'Listed env vars'
    | 'Pulled env vars'
    | 'Redeployed'
    | 'Deployed'
    | 'Promoted deployment'
    | 'Checked acceptance setup'
    | 'Viewed acceptance'
    | 'Read acceptance feedback'
    | 'Listed acceptances'
    | 'Published acceptance'
    | 'Published acceptance round'
    | 'Linked PR to acceptance';

/**
 * Options of `gh`, `vc`, and `lh` whose value is the next word, so `gh issue view -R owner/app 12` names `12`, not
 * `owner/app`. Short options that are booleans on some subcommands (`gh pr view -w` opens the browser) are left out; a
 * value they mis-skip only costs the subject, never a wrong one.
 */
const VALUE_OPTIONS = new Set([
    '-R',
    '--repo',
    '-t',
    '--title',
    '-b',
    '--body',
    '-F',
    '--body-file',
    '-l',
    '--label',
    '-a',
    '--assignee',
    '-A',
    '--author',
    '-S',
    '--search',
    '-s',
    '--state',
    '-L',
    '--limit',
    '--json',
    '-q',
    '--jq',
    '--template',
    '-B',
    '--base',
    '-H',
    '--head',
    '--header',
    '-m',
    '--milestone',
    '-p',
    '--project',
    '--workflow',
    '-u',
    '--user',
    '-e',
    '--event',
    '-j',
    '--job',
    '--branch',
    '-X',
    '--method',
    '-f',
    '--raw-field',
    '--field',
    '--input',
    '--hostname',
    '--cache',
    '--preview',
    '-r',
    '--reviewer',
    '--add-label',
    '--remove-label',
    '--add-assignee',
    '--remove-assignee',
    '--scope',
    '--token',
    '--env',
    '--environment',
    '--cwd',
    '--target',
    '--meta',
    '--output',
]);

/**
 * The value of the first of `options` in `words`, as `-m "message"` or `--message=message`.
 */
export function optionValue(
    words: readonly string[],
    options: readonly string[],
): string | undefined {
    const exact = new Set(options);
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? '';
        if (exact.has(word)) return words[index + 1];
        const option = options.find((candidate) => word.startsWith(`${candidate}=`));
        if (option) return word.slice(option.length + 1);
    }
    return undefined;
}

/**
 * The words that are not options or option values.
 */
function positionals(words: readonly string[]): string[] {
    const values: string[] = [];
    for (let index = 0; index < words.length; index += 1) {
        const word = words[index] ?? '';
        if (word === '--') {
            values.push(...words.slice(index + 1));
            break;
        }
        if (word !== '-' && word.startsWith('-')) {
            if (VALUE_OPTIONS.has(word)) index += 1;
            continue;
        }
        values.push(word);
    }
    return values;
}

/**
 * `#12` for an issue, pull request, or run named by number (`12`, `#12`) or URL (`.../issues/12`).
 */
function numberReference(word: string | undefined): string | undefined {
    const match = /^#?(\d+)$|\/(?:issues|pull|runs)\/(\d+)/u.exec(word ?? '');
    const digits = match?.slice(1).find(Boolean);
    return digits && `#${digits}`;
}

function cli(
    label: AgentShellCliLabel,
    subject: string | undefined,
    isCodeSubject = true,
): AgentShellCliAction {
    const trimmed = subject?.trim();
    return trimmed
        ? { kind: 'cli', label, subject: trimmed, isCodeSubject }
        : { kind: 'cli', label, isCodeSubject };
}

const PULL_REQUEST_ACTIONS: Readonly<Record<string, AgentShellPullRequestAction | undefined>> = {
    create: 'create',
    merge: 'merge',
    edit: 'edit',
    ready: 'edit',
    comment: 'comment',
    review: 'comment',
    close: 'close',
    view: 'check',
    checks: 'check',
    diff: 'check',
    status: 'check',
    list: 'list',
};

function pullRequestStep(arguments_: readonly string[]): AgentShellCliAction | null {
    const [verb = '', ...rest] = arguments_;
    const action = PULL_REQUEST_ACTIONS[verb];
    if (!action) return null;
    const subject =
        action === 'create'
            ? optionValue(rest, ['--title', '-t'])?.trim()
            : action === 'list'
              ? (optionValue(rest, ['--search', '-S']) ?? optionValue(rest, ['--head', '-H']))
              : numberReference(positionals(rest).at(0));
    return subject ? { kind: 'pullRequest', action, subject } : { kind: 'pullRequest', action };
}

const ISSUE_LABELS: Readonly<Record<string, AgentShellCliLabel | undefined>> = {
    view: 'Viewed issue',
    edit: 'Updated issue',
    comment: 'Commented on issue',
    close: 'Closed issue',
    reopen: 'Reopened issue',
};

function issueStep(arguments_: readonly string[]): AgentShellCliAction | null {
    const [verb = '', ...rest] = arguments_;
    if (verb === 'create') return cli('Opened issue', optionValue(rest, ['--title', '-t']), false);
    if (verb === 'list') {
        const search = optionValue(rest, ['--search', '-S']);
        if (search) return cli('Listed issues', search, false);
        const label = optionValue(rest, ['--label', '-l']);
        return cli('Listed issues', label && `label: ${label}`);
    }
    const label = ISSUE_LABELS[verb];
    return label ? cli(label, numberReference(positionals(rest).at(0))) : null;
}

function runStep(arguments_: readonly string[]): AgentShellCliAction | null {
    const [verb = '', ...rest] = arguments_;
    const run = numberReference(positionals(rest).at(0))?.slice(1);
    switch (verb) {
        case 'view':
        case 'watch': {
            const isLog = rest.some((word) => word === '--log' || word === '--log-failed');
            return cli(isLog ? 'Read CI logs' : 'Checked CI run', run);
        }
        case 'list': {
            return cli(
                'Listed CI runs',
                optionValue(rest, ['--branch', '-b']) ?? optionValue(rest, ['--workflow', '-w']),
            );
        }
        case 'rerun': {
            return cli('Reran CI', run);
        }
        case 'cancel': {
            return cli('Canceled CI run', run);
        }
        default: {
            return null;
        }
    }
}

/**
 * A REST endpoint as the resource it names: `repos/owner/app/pulls/12?per_page=100` reads `owner/app/pulls/12`.
 */
function apiEndpoint(arguments_: readonly string[]): string | undefined {
    const endpoint = positionals(arguments_).at(0);
    if (!endpoint) return undefined;
    if (endpoint === 'graphql') return 'GraphQL';
    return endpoint
        .replace(/^\//u, '')
        .replace(/^repos\//u, '')
        .replace(/\?.*$/u, '');
}

function ghStep(arguments_: readonly string[]): AgentShellCliAction | null {
    const [group = '', ...rest] = arguments_;
    switch (group) {
        case 'pr': {
            return pullRequestStep(rest);
        }
        case 'issue': {
            return issueStep(rest);
        }
        case 'run': {
            return runStep(rest);
        }
        case 'workflow': {
            return rest[0] === 'run'
                ? cli('Started workflow', positionals(rest.slice(1)).at(0))
                : null;
        }
        case 'api': {
            return cli('Called GitHub API', apiEndpoint(rest));
        }
        default: {
            return null;
        }
    }
}

/**
 * A deployment named by URL reads as its host; a deployment ID (`dpl_...`) or project name as written.
 */
function deploymentName(word: string | undefined): string | undefined {
    if (!word) return undefined;
    // `URL.parse` reads `mailto:x` as a URL with an empty host.
    const host = URL.parse(word)?.host;
    if (host) return host;
    return word;
}

function vercelStep(arguments_: readonly string[]): AgentShellCliAction | null {
    const [verb = '', ...rest] = positionals(arguments_);
    const target = deploymentName(rest.at(0));
    switch (verb) {
        case 'inspect': {
            return cli(
                arguments_.includes('--logs') ? 'Read deployment logs' : 'Inspected deployment',
                target,
            );
        }
        case 'logs': {
            return cli('Read deployment logs', target);
        }
        case 'ls':
        case 'list': {
            return cli('Listed deployments', rest.at(0));
        }
        case 'env': {
            if (rest[0] === 'ls' || rest[0] === 'list') return cli('Listed env vars', rest.at(1));
            if (rest[0] === 'pull') return cli('Pulled env vars', undefined);
            return null;
        }
        case 'redeploy': {
            return cli('Redeployed', target);
        }
        case 'deploy': {
            return cli('Deployed', arguments_.includes('--prod') ? 'production' : undefined);
        }
        case 'promote': {
            return cli('Promoted deployment', target);
        }
        default: {
            return null;
        }
    }
}

function lobeHubStep(arguments_: readonly string[]): AgentShellCliAction | null {
    const [group = '', verb = '', ...rest] = positionals(arguments_);
    if (group !== 'acceptance') return null;
    switch (verb) {
        case 'preflight': {
            return cli('Checked acceptance setup', undefined);
        }
        case 'view':
        case 'get': {
            return cli('Viewed acceptance', rest.at(0));
        }
        case 'feedback': {
            return cli('Read acceptance feedback', rest.at(0));
        }
        case 'list': {
            return cli('Listed acceptances', undefined);
        }
        case 'publish': {
            return cli('Published acceptance', undefined);
        }
        case 'run': {
            return rest[0] === 'ingest' ? cli('Published acceptance round', undefined) : null;
        }
        case 'link-pr': {
            return cli('Linked PR to acceptance', numberReference(rest.at(1)) ?? rest.at(1));
        }
        default: {
            return null;
        }
    }
}

const CLI_STEPS: Readonly<
    Record<string, ((arguments_: readonly string[]) => AgentShellCliAction | null) | undefined>
> = {
    gh: ghStep,
    vc: vercelStep,
    vercel: vercelStep,
    lh: lobeHubStep,
};

/**
 * Reads one unwrapped command (`words`, its text `text`) of `gh`, `vc`, or `lh`. A subcommand this module does not name
 * still reads as `Ran` with only this command as the subject, so `cd ~/code/app && gh label list` reads `Ran gh label
 * list`. Anything else returns `null`.
 */
export function describeCliStep(
    words: readonly string[],
    text: string,
): AgentShellCliAction | null {
    const [name = '', ...arguments_] = words;
    const step = CLI_STEPS[name];
    if (!step) return null;
    return step(arguments_) ?? cli('Ran', text);
}

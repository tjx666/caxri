import { SHELL_COMMAND_SOURCE } from './shell-command-source';

/**
 * The one Shell classifier that decides whether a Bash command directly invokes `git worktree add`.
 *
 * One `sh`/`bash`/`zsh -c <script>` layer is unwrapped, because Codex reports every command it runs as `/bin/zsh -lc
 * "<script>"`; without it no Codex command would ever classify.
 *
 * It is plain JavaScript source rather than TypeScript because the standalone hook bridge (`bridge.cjs`) embeds it
 * verbatim after {@link SHELL_COMMAND_SOURCE}, whose parser it calls, while Claude Chat runs the same classifier in
 * Server Core through {@link commandCreatesWorktree}. Keeping a single source means a command the Terminal path
 * attributes is attributed identically in Chat.
 *
 * `commandWorktreeAddPath` additionally extracts the `<path>` operand, resolved to a normalized absolute path only when
 * it is absolute, relative to an absolute `-C <dir>`, or relative to the caller's known absolute cwd (and no earlier
 * `cd`/`pushd` segment moved it). Anything else, including shell expansions, yields no path. The path is a hint, never
 * authority: Server Core only uses it to choose among additions that Git itself reports.
 */
export const WORKTREE_COMMAND_SOURCE = `const MAX_WORKTREE_PATH_LENGTH = 1024;
function normalizeAbsolutePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return '/' + parts.join('/');
}
function isLiteralPathToken(token) {
  return token.length > 0 && !/[$*?[{~]/u.test(token) && !token.includes(String.fromCharCode(96)) && !token.includes(String.fromCharCode(0));
}
function resolveWorktreeAddPath(target, directories, state) {
  if (typeof target !== 'string' || !isLiteralPathToken(target) || state.redirected) return undefined;
  let base = typeof state.cwd === 'string' && state.cwd[0] === '/' && !state.moved ? state.cwd : undefined;
  for (const directory of directories) {
    if (!isLiteralPathToken(directory)) return undefined;
    if (directory[0] === '/') base = normalizeAbsolutePath(directory);
    else if (base !== undefined) base = normalizeAbsolutePath(base + '/' + directory);
    else return undefined;
  }
  let resolved;
  if (target[0] === '/') resolved = normalizeAbsolutePath(target);
  else if (base !== undefined) resolved = normalizeAbsolutePath(base + '/' + target);
  if (resolved === undefined || resolved === '/' || resolved.length > MAX_WORKTREE_PATH_LENGTH) return undefined;
  return resolved;
}
function worktreeAddInvocation(segment, depth, state) {
  const tokens = tokenizeShellSegment(segment);
  let index = findCommandIndex(tokens);
  const program = basename(tokens[index] ?? '');
  if (program === 'cd' || program === 'pushd' || program === 'popd') {
    state.moved = true;
    return undefined;
  }
  if (program === 'sh' || program === 'bash' || program === 'zsh') {
    const script = /^-[A-Za-z]*c[A-Za-z]*$/u.test(tokens[index + 1] ?? '') ? tokens[index + 2] : undefined;
    if (depth !== 0 || typeof script !== 'string') return undefined;
    for (const inner of splitShellSegments(script)) {
      const found = worktreeAddInvocation(inner, 1, state);
      if (found) return found;
    }
    return undefined;
  }
  if (program !== 'git') return undefined;
  index += 1;
  const optionsWithValues = new Set(['-C', '-c', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);
  const directories = [];
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (option === '--git-dir' || option === '--work-tree' || option.startsWith('--git-dir=') || option.startsWith('--work-tree=')) state.redirected = true;
    if (option === '-C') directories.push(tokens[index] ?? '');
    if (optionsWithValues.has(option)) index += 1;
  }
  if (tokens[index] !== 'worktree' || tokens[index + 1] !== 'add') return undefined;
  index += 2;
  const addOptionsWithValues = new Set(['-b', '-B', '--reason']);
  let target;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (token === '--') {
      target = tokens[index];
      break;
    }
    if (!token.startsWith('-')) {
      target = token;
      break;
    }
    if (addOptionsWithValues.has(token) || /^-[fdq]+[bB]$/u.test(token)) index += 1;
  }
  return { path: resolveWorktreeAddPath(target, directories, state) };
}
function analyzeWorktreeCommand(command, cwd) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_SHELL_COMMAND_LENGTH) return undefined;
  const state = { cwd, moved: false, redirected: false };
  for (const segment of splitShellSegments(command)) {
    const found = worktreeAddInvocation(segment, 0, state);
    if (found) return found;
  }
  return undefined;
}
function commandCreatesWorktree(command) {
  return analyzeWorktreeCommand(command, undefined) !== undefined;
}
function commandWorktreeAddPath(command, cwd) {
  const found = analyzeWorktreeCommand(command, cwd);
  return found ? found.path : undefined;
}
`;

/**
 * Evaluates only the repository-owned classifier source above, never provider input, so the Terminal bridge and Chat
 * share one implementation.
 */

// oxlint-disable-next-line typescript/no-implied-eval -- see the JSDoc: the source is a repository constant shared with `bridge.cjs`.
const loadClassifier = new Function(
    `${SHELL_COMMAND_SOURCE}\n${WORKTREE_COMMAND_SOURCE}\nreturn { commandCreatesWorktree, commandWorktreeAddPath };`,
) as () => {
    commandCreatesWorktree: (command: unknown) => boolean;
    commandWorktreeAddPath: (command: unknown, cwd: unknown) => string | undefined;
};

const classifier = loadClassifier();

/**
 * Whether a Bash command directly invokes `git worktree add`, judged by the same source the hook bridge embeds.
 */
export const commandCreatesWorktree = classifier.commandCreatesWorktree;

/**
 * The normalized absolute `<path>` a `git worktree add` command names, or `undefined` when it cannot be resolved
 * without guessing. A filesystem path from the Agent's command: never log it.
 */
export const commandWorktreeAddPath = classifier.commandWorktreeAddPath;

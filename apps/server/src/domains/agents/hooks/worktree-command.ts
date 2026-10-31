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
 */
export const WORKTREE_COMMAND_SOURCE = `function segmentCreatesWorktree(segment, depth) {
  const tokens = tokenizeShellSegment(segment);
  let index = findCommandIndex(tokens);
  const program = basename(tokens[index] ?? '');
  if (program === 'sh' || program === 'bash' || program === 'zsh') {
    const script = /^-[A-Za-z]*c[A-Za-z]*$/u.test(tokens[index + 1] ?? '') ? tokens[index + 2] : undefined;
    return depth === 0 && typeof script === 'string' && splitShellSegments(script).some((inner) => segmentCreatesWorktree(inner, 1));
  }
  if (program !== 'git') return false;
  index += 1;
  const optionsWithValues = new Set(['-C', '-c', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (optionsWithValues.has(option)) index += 1;
  }
  return tokens[index] === 'worktree' && tokens[index + 1] === 'add';
}
function commandCreatesWorktree(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_SHELL_COMMAND_LENGTH) return false;
  return splitShellSegments(command).some((segment) => segmentCreatesWorktree(segment, 0));
}
`;

/**
 * Evaluates only the repository-owned classifier source above, never provider input, so the Terminal bridge and Chat
 * share one implementation.
 */

// oxlint-disable-next-line typescript/no-implied-eval -- see the JSDoc: the source is a repository constant shared with `bridge.cjs`.
const loadClassifier = new Function(
    `${SHELL_COMMAND_SOURCE}\n${WORKTREE_COMMAND_SOURCE}\nreturn commandCreatesWorktree;`,
) as () => (command: unknown) => boolean;

/**
 * Whether a Bash command directly invokes `git worktree add`, judged by the same source the hook bridge embeds.
 */
export const commandCreatesWorktree = loadClassifier();

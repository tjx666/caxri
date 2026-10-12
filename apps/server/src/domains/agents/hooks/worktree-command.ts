/**
 * The one Shell classifier that decides whether a Bash command directly invokes `git worktree add`.
 *
 * It is plain JavaScript source rather than TypeScript because the standalone hook bridge (`bridge.cjs`) embeds it
 * verbatim, while Claude Chat runs the same classifier in Server Core through {@link commandCreatesWorktree}. Keeping a
 * single source means a command the Terminal path attributes is attributed identically in Chat. Serializing a compiled
 * function instead is unsafe: the bundler may rename its helpers (`basename` collides with `node:path`).
 */
export const WORKTREE_COMMAND_SOURCE = String.raw`function splitShellSegments(command) {
  const segments = [];
  let segment = '';
  let quote;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      segment += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      segment += character;
      escaped = true;
      continue;
    }
    if (quote) {
      segment += character;
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      segment += character;
      continue;
    }
    const separator = character === ';' || character === '\n' || character === '\r' ||
      character === '(' || character === ')' || character === '|' ||
      (character === '&' && command[index + 1] === '&');
    if (!separator) {
      segment += character;
      continue;
    }
    if (segment.trim()) segments.push(segment);
    segment = '';
    if ((character === '|' && command[index + 1] === '|') ||
        (character === '&' && command[index + 1] === '&')) index += 1;
  }
  if (segment.trim()) segments.push(segment);
  return segments;
}
function tokenizeShellSegment(segment) {
  const tokens = [];
  let token = '';
  let quote;
  let escaped = false;
  const finish = () => {
    if (token) tokens.push(token);
    token = '';
  };
  for (const character of segment) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      finish();
    } else {
      token += character;
    }
  }
  finish();
  return tokens;
}
function basename(token) {
  return token.slice(token.lastIndexOf('/') + 1);
}
function findCommandIndex(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
  for (let wrappers = 0; wrappers < 4; wrappers += 1) {
    const command = basename(tokens[index] ?? '');
    if (command === 'command' || command === 'sudo' || command === 'rtk') {
      index += 1;
      continue;
    }
    if (command === 'env') {
      index += 1;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
      continue;
    }
    break;
  }
  return index;
}
function segmentCreatesWorktree(segment) {
  const tokens = tokenizeShellSegment(segment);
  let index = findCommandIndex(tokens);
  if (basename(tokens[index] ?? '') !== 'git') return false;
  index += 1;
  const optionsWithValues = new Set(['-C', '-c', '--exec-path', '--git-dir', '--namespace', '--super-prefix', '--work-tree']);
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (optionsWithValues.has(option)) index += 1;
  }
  return tokens[index] === 'worktree' && tokens[index + 1] === 'add';
}
const MAX_WORKTREE_COMMAND_LENGTH = 32768;
function commandCreatesWorktree(command) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_WORKTREE_COMMAND_LENGTH) return false;
  return splitShellSegments(command).some(segmentCreatesWorktree);
}
`;

/**
 * Evaluates only the repository-owned classifier source above, never provider input, so the Terminal bridge and Chat
 * share one implementation.
 */

// oxlint-disable-next-line typescript/no-implied-eval -- see the JSDoc: the source is a repository constant shared with `bridge.cjs`.
const loadClassifier = new Function(
    `${WORKTREE_COMMAND_SOURCE}\nreturn commandCreatesWorktree;`,
) as () => (command: unknown) => boolean;

/**
 * Whether a Bash command directly invokes `git worktree add`, judged by the same source the hook bridge embeds.
 */
export const commandCreatesWorktree = loadClassifier();

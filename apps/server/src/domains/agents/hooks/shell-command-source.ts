/**
 * The one Shell command parser and pattern matcher shared by the standalone hook bridge and Server Core.
 *
 * It is plain JavaScript source rather than TypeScript because the hook bridge (`bridge.cjs`) embeds it verbatim, while
 * Server Core compiles the same source through {@link shellCommandMatchesAny}, so a command the Terminal path classifies
 * is classified identically in Chat. Serializing a compiled function instead is unsafe: the bundler may rename its
 * helpers (`basename` collides with `node:path`). Classifiers built on it, such as `worktree-command.ts`, append their
 * own source after this one.
 *
 * Pattern syntax is owned by `@caxri/protocol` (`shell-command-patterns.ts`): text patterns are prefixes of a
 * sub-command that end at whitespace, `*` stands for any run of characters, and `/source/flags` is a regular
 * expression.
 */
export const SHELL_COMMAND_SOURCE = String.raw`function splitShellSegments(command) {
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
function skipTimeoutArguments(tokens, index) {
  const optionsWithValues = new Set(['-s', '-k', '--signal', '--kill-after']);
  while (index < tokens.length && tokens[index].startsWith('-')) {
    const option = tokens[index];
    index += 1;
    if (option === '--') break;
    if (optionsWithValues.has(option)) index += 1;
  }
  return index + 1;
}
function findCommandIndex(tokens) {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
  for (let wrappers = 0; wrappers < 6; wrappers += 1) {
    const command = basename(tokens[index] ?? '');
    if (command === 'command' || command === 'sudo' || command === 'rtk' || command === 'nohup' || command === 'exec') {
      index += 1;
      continue;
    }
    if (command === 'env') {
      index += 1;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? '')) index += 1;
      continue;
    }
    if (command === 'timeout') {
      index = skipTimeoutArguments(tokens, index + 1);
      continue;
    }
    break;
  }
  return index;
}
const MAX_SHELL_COMMAND_LENGTH = 32768;
const MAX_SHELL_COMMAND_PATTERNS = 64;
function compileShellCommandPattern(pattern) {
  if (typeof pattern !== 'string') return;
  const value = pattern.trim();
  if (!value || value.length > 256) return;
  const regex = /^\/(.+)\/([imsu]*)$/su.exec(value);
  try {
    if (regex) return new RegExp(regex[1], regex[2]);
    const source = value.split(/\s+/u).map((word) =>
      word.split('*').map((part) => part.replace(/[.*+?^$|{}()[\]\\]/gu, '\\$&')).join('.*')).join('\\s+');
    return new RegExp('^' + source + '(?=\\s|$)', 'su');
  } catch {
    return;
  }
}
function compileShellCommandPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns.slice(0, MAX_SHELL_COMMAND_PATTERNS).map(compileShellCommandPattern).filter(Boolean);
}
function shellSegmentTexts(segment) {
  const tokens = tokenizeShellSegment(segment);
  const command = tokens.slice(findCommandIndex(tokens));
  if (command.length === 0) return [];
  const text = command.join(' ');
  const name = basename(command[0]);
  return name === command[0] ? [text] : [text, [name, ...command.slice(1)].join(' ')];
}
function shellCommandMatchesAny(command, patterns) {
  if (typeof command !== 'string' || command.length === 0 || command.length > MAX_SHELL_COMMAND_LENGTH) return false;
  const compiled = compileShellCommandPatterns(patterns);
  if (compiled.length === 0) return false;
  return splitShellSegments(command).some((segment) =>
    shellSegmentTexts(segment).some((text) => compiled.some((pattern) => pattern.test(text))));
}
`;

// Both linters flag the Function constructor; each suppression must sit directly above it, so oxlint uses a range.
// See the JSDoc: the source is a repository constant shared with `bridge.cjs`.
/* oxlint-disable typescript/no-implied-eval */
// react-doctor-disable-next-line react-doctor/no-eval
const loadMatcher = new Function(
    `${SHELL_COMMAND_SOURCE}\nreturn shellCommandMatchesAny;`,
) as () => (command: unknown, patterns: readonly string[]) => boolean;
/* oxlint-enable typescript/no-implied-eval */

/**
 * Whether any sub-command of a Shell command line matches one of the patterns, judged by the same source the hook
 * bridge embeds. A command with no matching sub-command, an empty or oversized command, and an empty list all return
 * `false`.
 */
export const shellCommandMatchesAny = loadMatcher();

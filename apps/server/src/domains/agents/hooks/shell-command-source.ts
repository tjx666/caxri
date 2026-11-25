/**
 * The Shell command parser shared by the standalone hook bridge and Server Core's hook classifiers.
 *
 * Presentation code parses commands its own way and is not bound to this parser's semantics: the tool-row word splitter
 * (`@caxri/protocol` `tool-rows/shell/words.ts`) refuses input it cannot split faithfully, and the Chat trackers keep
 * `$(...)` whole. A change here therefore does not change how a command is labeled in Chat.
 *
 * It is plain JavaScript source rather than TypeScript because the hook bridge (`bridge.cjs`) embeds it verbatim, while
 * Server Core compiles the same source, so a command the Terminal path classifies is classified identically in Chat.
 * Serializing a compiled function instead is unsafe: the bundler may rename its helpers (`basename` collides with
 * `node:path`). Classifiers built on it, such as `worktree-command.ts`, append their own source after this one.
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
`;

// A deliberately small, non-executing shell lexer. Quotes protect separators;
// expansions/escapes remain forbidden by policy rather than being interpreted.
function splitCommands(source) {
  const commands = []; let words = [], word = '', quote = '', started = false;
  const endWord = () => { if (started) words.push(word); word = ''; started = false; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) { if (ch === quote) quote = ''; else word += ch; started = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if (ch === '&' && source[i + 1] !== '&') throw new Error('Background execution is forbidden');
      if (source[i + 1] === ch && (ch === '&' || ch === '|')) i++;
      endCommand(); continue;
    }
    if (/\s/.test(ch)) { endWord(); continue; }
    if (ch === '<' || ch === '>') { endWord(); continue; }
    word += ch; started = true;
  }
  if (quote) throw new Error('Unclosed shell quote');
  endCommand();
  return commands;
}
export function simpleCommands(source, depth = 0) {
  if (depth > 4) throw new Error('Too many shell wrappers');
  return splitCommands(source).flatMap(words => {
    // Only known shell launchers in their exact -c/-lc form are wrappers.
    if (/^(?:(?:\/bin|\/usr\/bin)\/)?(?:sh|bash|zsh)$/.test(words[0]) && ['-c','-lc'].includes(words[1])) {
      if (words.length !== 3) throw new Error('Unsupported shell wrapper arguments');
      return simpleCommands(words[2], depth + 1);
    }
    return [words];
  });
}

import { createTwoFilesPatch } from 'diff';
export function normalizeReview(text) {
  if (typeof text !== 'string') throw new Error('Expected text content');
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\n*$/, '');
  return normalized ? normalized + '\n' : '';
}
export function reviewDiff(file, before, after) {
  const oldText = normalizeReview(before), newText = normalizeReview(after);
  if (oldText === newText) return '(No content changes after normalizing line endings and trailing newlines.)';
  return createTwoFilesPatch(file, file, oldText, newText, 'before', 'after', { context: 3 });
}
export function proposedContent(tool, input, before) {
  if (tool === 'Write') {
    if (typeof input.content !== 'string') throw new Error('Missing file content');
    return input.content;
  }
  if (typeof input.old_string !== 'string' || !input.old_string || typeof input.new_string !== 'string') throw new Error('Edit requires old_string and new_string');
  const occurrences = before.split(input.old_string).length - 1;
  if (!occurrences || (!input.replace_all && occurrences !== 1)) throw new Error('Edit must match exactly once unless replace_all is set');
  return input.replace_all ? before.replaceAll(input.old_string, input.new_string) : before.replace(input.old_string, input.new_string);
}

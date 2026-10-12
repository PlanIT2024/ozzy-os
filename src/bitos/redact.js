import { safeText } from '../brain/transcript.js';

// Taint is a permission policy, not a credential detector. Reuse the existing
// image/encoded-data filter, then exclude content-bearing fields recursively.
export function redact(value, env = process.env, depth = 0) {
  if (depth > 12) return '[omitted]';
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return '[binary omitted]';
  if (typeof value === 'string') {
    let text = safeText(value);
    for (const [key, secret] of Object.entries(env)) {
      if (/token|key|password|secret/i.test(key) && typeof secret === 'string' && secret.length >= 4) text = text.replaceAll(secret, '[redacted]');
    }
    return text.replace(/(?:export\s+)?\b[A-Za-z_][A-Za-z0-9_]*\s*=\s*[^\n]+/g, '[env omitted]')
      .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
      .replace(/\b(?:bearer\s+\S+|(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+)/gi, '[redacted]')
      .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 240);
  }
  if (Array.isArray(value)) return value.slice(0, 64).map(v => redact(v, env, depth + 1));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(text|typed_?text)$/i.test(key)) { result.text_length = typeof item === 'string' ? item.length : 0; continue; }
      if (/token|password|secret|api.?key|private.?key|authorization|credential|(^|_)key$|^(content|contents|file_?contents?|diff|prompt|response|data|buffer|pixels|env|command|stdout|stderr)$/i.test(key)) continue;
      result[key] = redact(item, env, depth + 1);
    }
    return result;
  }
  return value === null || ['number', 'boolean'].includes(typeof value) ? value : undefined;
}

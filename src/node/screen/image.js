import sharp from './sharp.js';
export const MAX_EDGE = 1568;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export function scaledSize(width, height, maxEdge = MAX_EDGE) {
  if (![width, height, maxEdge].every(n => Number.isInteger(n) && n > 0)) throw new Error('Invalid image dimensions');
  const ratio = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}
export async function encodeCapture(bytes, { monitors = [], capturedAt = new Date().toISOString(), maxBytes = MAX_IMAGE_BYTES } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 32 * 1024 * 1024) throw new Error('Capture input exceeds size limit');
  const input = sharp(bytes, { limitInputPixels: 64 * 1024 * 1024 });
  const { width, height } = await input.metadata();
  const scaled = scaledSize(width, height);
  const image = input.resize(scaled.width, scaled.height, { fit: 'fill', withoutEnlargement: true }).flatten({ background: '#000' });
  const [jpeg, png] = await Promise.all([image.clone().jpeg({ quality: 80 }).toBuffer(), image.clone().png().toBuffer()]);
  const usePNG = png.length < jpeg.length, buffer = usePNG ? png : jpeg;
  if (buffer.length > maxBytes) throw new Error('Scaled capture exceeds image byte limit');
  return { data: buffer.toString('base64'), mimeType: usePNG ? 'image/png' : 'image/jpeg', original: { width, height }, scaled, monitors, capturedAt, bytes: buffer.length };
}
export function validateCapture(result) {
  if (!result || !['image/png', 'image/jpeg'].includes(result.mimeType) || typeof result.data !== 'string' || result.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)) throw new Error('Invalid capture response');
  if (!result.original || !result.scaled || ![result.original.width, result.original.height, result.scaled.width, result.scaled.height].every(n => Number.isInteger(n) && n > 0) || Math.max(result.scaled.width, result.scaled.height) > MAX_EDGE || !Number.isFinite(Date.parse(result.capturedAt))) throw new Error('Invalid capture metadata');
  const expected = scaledSize(result.original.width, result.original.height);
  if (expected.width !== result.scaled.width || expected.height !== result.scaled.height || !Array.isArray(result.monitors) || result.monitors.length > 32) throw new Error('Invalid capture geometry');
  const buffer = Buffer.from(result.data, 'base64');
  if (buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== result.data || buffer.length !== result.bytes) throw new Error('Invalid capture size');
  return buffer;
}

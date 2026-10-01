export const MAX_MESSAGE = 8 * 1024 * 1024;
export const canonical = name => {
  if (typeof name !== 'string' || !/^[a-z0-9_-]{1,64}$/i.test(name)) throw new Error('Invalid machine name');
  return name.toLowerCase();
};
export function pack(meta, payload) {
  const header = Buffer.from(JSON.stringify(meta));
  if (header.length > 512) throw new Error('Routing header too large');
  const length = Buffer.alloc(2); length.writeUInt16BE(header.length);
  const frame = Buffer.concat([length, header, payload]);
  if (frame.length > MAX_MESSAGE) throw new Error('Message exceeds 8 MB');
  return frame;
}
export function unpack(frame) {
  if (frame.length > MAX_MESSAGE || frame.length < 3) throw new Error('Invalid frame size');
  const size = frame.readUInt16BE(0);
  if (size > 512 || size + 2 >= frame.length) throw new Error('Invalid routing header');
  const meta = JSON.parse(frame.subarray(2, size + 2).toString());
  if (Object.keys(meta).sort().join(',') !== 'from,id,to' || canonical(meta.from) !== meta.from || canonical(meta.to) !== meta.to || !/^[a-f0-9-]{36}$/.test(meta.id)) throw new Error('Invalid routing metadata');
  return { meta, payload: frame.subarray(size + 2) };
}

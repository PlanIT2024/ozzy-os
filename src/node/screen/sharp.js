// Set before native libvips initialization: bounded captures stay below this RAM
// threshold, preventing its large-image loader from choosing a temporary file.
process.env.VIPS_DISC_THRESHOLD = '1073741824';
const { default: sharp } = await import('sharp');
sharp.cache({ files: 0 });
export default sharp;

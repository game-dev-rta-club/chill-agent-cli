// Read an image's displayed width and height from its header, without
// decoding it, so the Web can reserve its box before the image arrives.
// Returns null for anything it cannot read.
export function imageSize(data) {
  try {
    if (data.length >= 24 && data.toString('latin1', 1, 4) === 'PNG') return size(data.readUInt32BE(16), data.readUInt32BE(20));
    if (data.length >= 30 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return webpSize(data);
    if (data[0] === 0xff && data[1] === 0xd8) return jpegSize(data);
  } catch { /* A truncated header has no size. */ }
  return null;
}
const size = (width, height) => width > 0 && height > 0 ? {width, height} : null;
function webpSize(data) {
  const chunk = data.toString('latin1', 12, 16);
  if (chunk === 'VP8X') return size(data.readUIntLE(24, 3) + 1, data.readUIntLE(27, 3) + 1);
  if (chunk === 'VP8L' && data[20] === 0x2f) {
    const bits = data.readUInt32LE(21);
    return size((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8 ') return size(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
  return null;
}
// Browsers turn a JPEG by its EXIF orientation; 5 to 8 swap width and height.
function jpegSize(data) {
  let offset = 2, turned = false;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1];
    if (marker === 0xff) { offset++; continue; }
    const length = data.readUInt16BE(offset + 2);
    if (marker === 0xe1 && data.toString('latin1', offset + 4, offset + 10) === 'Exif\0\0') turned = exifOrientation(data.subarray(offset + 10, offset + 2 + length)) >= 5;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      const height = data.readUInt16BE(offset + 5), width = data.readUInt16BE(offset + 7);
      return turned ? size(height, width) : size(width, height);
    }
    offset += 2 + length;
  }
  return null;
}
function exifOrientation(tiff) {
  const little = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = at => little ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const ifd = little ? tiff.readUInt32LE(4) : tiff.readUInt32BE(4);
  for (let i = 0, count = u16(ifd); i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}

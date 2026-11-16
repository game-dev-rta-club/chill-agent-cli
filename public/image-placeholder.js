import {rgbaToThumbHash, thumbHashToDataURL} from 'thumbhash';

// A ThumbHash is a blurred picture of an image in about 25 bytes, stored as
// base64. It is read from a loaded image at most 100 pixels on a side.
export function thumbHashOf(img) {
  const scale = Math.min(1, 100 / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale)), height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(img, 0, 0, width, height);
  return btoa(String.fromCharCode(...rgbaToThumbHash(width, height, context.getImageData(0, 0, width, height).data)));
}
const pictures = new Map();
export function thumbHashPicture(hash) {
  if (!pictures.has(hash)) pictures.set(hash, thumbHashToDataURL(Uint8Array.from(atob(hash), c => c.charCodeAt(0))));
  return pictures.get(hash);
}

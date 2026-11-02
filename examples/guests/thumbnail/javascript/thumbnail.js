import { images } from 'boundary:guest/footprints@1.0.0';

function errorPayload(message) {
  return JSON.stringify({ error: message });
}

function thumbnailDimensions(width, height, maxWidth) {
  if (maxWidth <= 0) {
    throw errorPayload('invalid max width');
  }
  if (width === 0 || height === 0) {
    throw errorPayload('invalid source dimensions');
  }
  const outW = Math.min(maxWidth, width);
  const outH = Math.max(1, Math.round((height * outW) / width));
  return { width: outW, height: outH };
}

export function imagesMakeThumbnail(input) {
  const parsed = JSON.parse(input);
  const imageId = parsed.imageId;
  const maxWidth = parsed.maxWidth;
  if (typeof imageId !== 'string') {
    throw errorPayload('imageId is required');
  }
  if (typeof maxWidth !== 'number') {
    throw errorPayload('maxWidth is required');
  }
  const reply = images(JSON.stringify({ imageId }));
  const source = JSON.parse(reply);
  const scaled = thumbnailDimensions(source.width, source.height, maxWidth);
  return JSON.stringify({
    imageId,
    width: scaled.width,
    height: scaled.height,
  });
}

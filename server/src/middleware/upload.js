import multer from 'multer';
import { config } from '../config.js';
import { badRequest } from './error.js';

export const IMAGE_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export const AUDIO_EXT = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
};

export const FILE_EXT = { ...IMAGE_EXT, ...AUDIO_EXT };
export const ALLOWED_IMAGE_MIME = new Set(Object.keys(IMAGE_EXT));
export const ALLOWED_AUDIO_MIME = new Set(Object.keys(AUDIO_EXT));
export const ALLOWED_ORDER_MIME = new Set(Object.keys(FILE_EXT));

export function createUpload(allowedMime, rejectMessage) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.upload.maxBytes, files: 1, fields: 10 },
    fileFilter: (req, file, cb) => {
      file.mimetype = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
      if (!allowedMime.has(file.mimetype)) return cb(badRequest(rejectMessage));
      cb(null, true);
    },
  });
}

/** Reject files whose bytes don't look like the declared image type. */
export function sniffImage(file) {
  if (!file || !file.mimetype.startsWith('image/')) return;
  const b = file.buffer;
  const ok = {
    'image/jpeg': b[0] === 0xff && b[1] === 0xd8,
    'image/png': b.subarray(0, 4).toString('hex') === '89504e47',
    'image/webp': b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
    'image/heic': b.subarray(4, 8).toString() === 'ftyp',
    'image/heif': b.subarray(4, 8).toString() === 'ftyp',
  }[file.mimetype];
  if (!ok) throw badRequest('The photo file looks damaged or is not an image.');
}

/**
 * The files the system holds, named by id.
 *
 * A photo the owner sent, and — from a later step — a video the system made,
 * live here and nowhere else, and everything that refers to one does so by its
 * id. Nothing that a model writes is ever turned into a path: a tool takes ids
 * and returns ids, an attachment is an id, and an id the store does not hold
 * is refused. [ADR-0021](../../../docs/adr/0021-containment-is-an-allowlist-applied-to-every-call.md)
 * made the tool list an allowlist; this makes the file list one, for the same
 * reason — a path a model chose is a path somebody can talk it into.
 *
 * ## Named by what they contain
 *
 * The id is the first sixteen hex digits of the content's SHA-256: the same
 * photo sent twice is one file, and the id can be checked against the bytes at
 * any time. Sixty-four bits is collision-free at the scale of one person's
 * photos many times over, and short enough to read in a log line.
 *
 * ## The type is read from the bytes
 *
 * Not from the name, and not from what the sender declared. A file is accepted
 * as an image only when its first bytes say it is one of the four kinds the
 * provider takes, and it is stored and described as what it is.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '@cortana/core';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/**
 * The largest image accepted, in bytes.
 *
 * The provider refuses an image over five megabytes, and an image the store
 * accepts that the model then cannot be shown is a failure moved somewhere
 * harder to explain. A phone's photo sent through Telegram is a few hundred
 * kilobytes; this binds only a photo sent as an uncompressed file.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const EXTENSION: Readonly<Record<ImageType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/** What a held file is, without its bytes. */
export interface StoredMedia {
  readonly id: string;
  readonly sha256: string;
  readonly mediaType: ImageType;
  readonly bytes: number;
}

export interface MediaStore {
  /** Keeps an image and says what it is. The same bytes twice are one file. */
  put(data: Uint8Array): StoredMedia;
  /** What the store holds under `id`, or `null` — never a guess. */
  get(id: string): StoredMedia | null;
  /** The bytes of a held file. Throws for an id the store does not hold. */
  read(id: string): Uint8Array;
}

/** Which of the accepted image types these bytes are, by their first bytes. */
export function sniffImage(data: Uint8Array): ImageType | null {
  const starts = (...bytes: number[]) => bytes.every((byte, at) => data[at] === byte);
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  // RIFF, four bytes of length, then WEBP.
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

const ID = /^[0-9a-f]{16}$/;

export function createMediaStore(options: { readonly dir: string }): MediaStore {
  const dir = options.dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const locate = (id: string): { path: string; mediaType: ImageType } | null => {
    if (!ID.test(id)) return null;
    for (const mediaType of IMAGE_TYPES) {
      const path = join(dir, `${id}.${EXTENSION[mediaType]}`);
      try {
        statSync(path);
        return { path, mediaType };
      } catch {
        // Not this extension.
      }
    }
    return null;
  };

  const describe = (data: Uint8Array, mediaType: ImageType): StoredMedia => {
    const sha256 = createHash('sha256').update(data).digest('hex');
    return { id: sha256.slice(0, 16), sha256, mediaType, bytes: data.length };
  };

  return {
    put(data) {
      const mediaType = sniffImage(data);
      if (mediaType === null) {
        throw new AppError('this is not an image the system can use (JPEG, PNG, WebP or GIF)', {
          category: 'contract',
          code: 'media-not-an-image',
          detail: { bytes: data.length },
        });
      }
      if (data.length > MAX_IMAGE_BYTES) {
        throw new AppError(
          `this image is ${Math.ceil(data.length / 1024 / 1024)} MB, and the most an image can be is 5 MB`,
          { category: 'contract', code: 'media-too-large', detail: { bytes: data.length } },
        );
      }
      const media = describe(data, mediaType);
      if (locate(media.id) === null) {
        // Written beside its final name and renamed, so a reader never finds a
        // half-written photo under a valid id.
        const final = join(dir, `${media.id}.${EXTENSION[mediaType]}`);
        const partial = `${final}.${randomBytes(4).toString('hex')}.partial`;
        writeFileSync(partial, data, { mode: 0o600 });
        renameSync(partial, final);
      }
      return media;
    },

    get(id) {
      const found = locate(id);
      if (found === null) return null;
      return describe(readFileSync(found.path), found.mediaType);
    },

    read(id) {
      const found = locate(id);
      if (found === null) {
        throw new AppError(`no file is held under "${id}"`, {
          category: 'contract',
          code: 'media-unknown',
          detail: { id },
        });
      }
      return readFileSync(found.path);
    },
  };
}

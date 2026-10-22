/**
 * The files the system holds, named by id.
 *
 * A photo or a clip the owner sent, and a video the system made, live here
 * and nowhere else, and everything that refers to one does so by its
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
 * provider takes, as a video only when they say it is an MP4 (or the QuickTime
 * file a phone records, which is the same container), and it is stored and
 * described as what it is.
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

/**
 * A video: one the system made, or a clip the owner sent. Either is kept as an
 * MP4 container, and only system code ever opens one — a model is shown frames.
 */
export const VIDEO_TYPE = 'video/mp4';
export type MediaType = ImageType | typeof VIDEO_TYPE;

/**
 * The largest video kept, in bytes: what a Telegram bot may upload. A video
 * the store held and no channel could deliver would be a file made for nobody.
 */
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

const EXTENSION: Readonly<Record<MediaType, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
};
const TYPES = Object.keys(EXTENSION) as MediaType[];

/** What a held file is, without its bytes. */
export interface StoredMedia {
  readonly id: string;
  readonly sha256: string;
  readonly mediaType: MediaType;
  readonly bytes: number;
}

/** A held image — what `put` accepts, and the only kind a model can be shown. */
export interface StoredImage extends StoredMedia {
  readonly mediaType: ImageType;
}

export interface MediaStore {
  /** Keeps an image and says what it is. The same bytes twice are one file. */
  put(data: Uint8Array): StoredImage;
  /** Keeps a video. Separate from `put` because only an image can be shown to a model. */
  putVideo(data: Uint8Array): StoredMedia;
  /**
   * Keeps what a person sent — an image or a video, by its first bytes — or
   * refuses it in a sentence. Anything else is neither, whatever it was called.
   */
  accept(data: Uint8Array): StoredMedia;
  /**
   * Where a held file is on this machine, for system code handing it to a
   * program such as `ffmpeg`. Never shown to a model: a model names files by
   * id, and this is the one place an id becomes a path.
   */
  localPath(id: string): string | null;
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

/**
 * Whether these bytes are an MP4 — or a phone's QuickTime file, the same
 * container — which says so four bytes in: a box called `ftyp`.
 */
export function sniffVideo(data: Uint8Array): boolean {
  return data[4] === 0x66 && data[5] === 0x74 && data[6] === 0x79 && data[7] === 0x70;
}

const ID = /^[0-9a-f]{16}$/;

export function createMediaStore(options: { readonly dir: string }): MediaStore {
  const dir = options.dir;
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const locate = (id: string): { path: string; mediaType: MediaType } | null => {
    if (!ID.test(id)) return null;
    for (const mediaType of TYPES) {
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

  const describe = <Type extends MediaType>(data: Uint8Array, mediaType: Type) => {
    const sha256 = createHash('sha256').update(data).digest('hex');
    return { id: sha256.slice(0, 16), sha256, mediaType, bytes: data.length };
  };

  const keep = (data: Uint8Array, mediaType: MediaType): void => {
    const id = describe(data, mediaType).id;
    if (locate(id) !== null) return;
    // Written beside its final name and renamed, so a reader never finds a
    // half-written file under a valid id.
    const final = join(dir, `${id}.${EXTENSION[mediaType]}`);
    const partial = `${final}.${randomBytes(4).toString('hex')}.partial`;
    writeFileSync(partial, data, { mode: 0o600 });
    renameSync(partial, final);
  };

  const store: MediaStore = {
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
      keep(data, mediaType);
      return describe(data, mediaType);
    },

    putVideo(data) {
      if (!sniffVideo(data)) {
        throw new AppError('this is not an MP4 video', {
          category: 'contract',
          code: 'media-not-a-video',
          detail: { bytes: data.length },
        });
      }
      if (data.length > MAX_VIDEO_BYTES) {
        throw new AppError(
          `the video is ${Math.ceil(data.length / 1024 / 1024)} MB, over the 50 MB a bot can send`,
          { category: 'contract', code: 'media-too-large', detail: { bytes: data.length } },
        );
      }
      keep(data, VIDEO_TYPE);
      return describe(data, VIDEO_TYPE);
    },

    accept(data) {
      if (sniffImage(data) !== null) return store.put(data);
      if (sniffVideo(data)) return store.putVideo(data);
      throw new AppError(
        'this is not a photo or a video the system can use (JPEG, PNG, WebP, GIF, MP4 or MOV)',
        { category: 'contract', code: 'media-not-supported', detail: { bytes: data.length } },
      );
    },

    localPath(id) {
      return locate(id)?.path ?? null;
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
  return store;
}

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppError } from '@cortana/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMediaStore, MAX_IMAGE_BYTES, sniffImage, sniffVideo } from './store.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-media-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The smallest bytes each format is recognised by, followed by filler. */
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
/** An MP4's first box, `ftyp`, then its brand — `qt  ` is a phone's QuickTime file. */
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const MOV = Uint8Array.from([0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20]);

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('what counts as an image', () => {
  it('is read from the bytes, for each of the four kinds the provider takes', () => {
    expect(sniffImage(JPEG)).toBe('image/jpeg');
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(GIF)).toBe('image/gif');
    expect(sniffImage(WEBP)).toBe('image/webp');
  });

  it('is nothing else, whatever it claims to be', () => {
    expect(sniffImage(new TextEncoder().encode('<svg>not a photo</svg>'))).toBeNull();
    expect(
      sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x41, 0x56, 0x49])),
    ).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
});

describe('what counts as a video', () => {
  it('is an MP4 or a phone’s QuickTime file, by the box four bytes in', () => {
    expect(sniffVideo(MP4)).toBe(true);
    expect(sniffVideo(MOV)).toBe(true);
    expect(sniffVideo(JPEG)).toBe(false);
    expect(sniffVideo(new Uint8Array(3))).toBe(false);
  });
});

describe('the store', () => {
  it('keeps an image under an id taken from its content, and gives it back', () => {
    const store = createMediaStore({ dir: join(root, 'media') });

    const held = store.put(JPEG);

    expect(held.id).toMatch(/^[0-9a-f]{16}$/);
    expect(held.sha256.startsWith(held.id)).toBe(true);
    expect(held).toMatchObject({ mediaType: 'image/jpeg', bytes: JPEG.length });
    expect(store.get(held.id)).toEqual(held);
    expect([...store.read(held.id)]).toEqual([...JPEG]);
  });

  it('keeps the same bytes once', () => {
    const dir = join(root, 'media');
    const store = createMediaStore({ dir });

    const first = store.put(PNG);
    const second = store.put(PNG);

    expect(second.id).toBe(first.id);
    expect(readdirSync(dir)).toEqual([`${first.id}.png`]);
  });

  it('keeps what it holds where only its owner can read it', () => {
    const dir = join(root, 'media');
    const store = createMediaStore({ dir });
    const held = store.put(JPEG);

    expect(statSync(dir).mode & 0o077).toBe(0);
    expect(statSync(join(dir, `${held.id}.jpg`)).mode & 0o077).toBe(0);
  });

  it('refuses what is not an image, and what is too large to show the model', () => {
    const store = createMediaStore({ dir: join(root, 'media') });

    expect(refusal(() => store.put(new TextEncoder().encode('hello')))).toBe('media-not-an-image');
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1);
    huge.set(JPEG);
    expect(refusal(() => store.put(huge))).toBe('media-too-large');
  });

  it('accepts what a person sends by its bytes — a photo as an image, a clip as a video', () => {
    const store = createMediaStore({ dir: join(root, 'media') });

    expect(store.accept(JPEG).mediaType).toBe('image/jpeg');
    expect(store.accept(MP4).mediaType).toBe('video/mp4');
    expect(store.accept(MOV).mediaType).toBe('video/mp4');
    expect(refusal(() => store.accept(new TextEncoder().encode('%PDF-1.7')))).toBe(
      'media-not-supported',
    );
  });

  it('cannot be walked out of with an id that is a path', () => {
    // A real file one directory up, named as an image. Without the id check the
    // store would find it: the extension is right and the file is there.
    writeFileSync(join(root, 'outside.jpg'), JPEG);
    const store = createMediaStore({ dir: join(root, 'media') });

    expect(store.get('../outside')).toBeNull();
    expect(refusal(() => store.read('../outside'))).toBe('media-unknown');
  });

  it('answers an id it does not hold with nothing, and never reads a path', () => {
    const store = createMediaStore({ dir: join(root, 'media') });
    store.put(JPEG);

    for (const id of ['0000000000000000', '../../etc/passwd', 'abc', '']) {
      expect(store.get(id)).toBeNull();
      expect(refusal(() => store.read(id))).toBe('media-unknown');
    }
  });
});

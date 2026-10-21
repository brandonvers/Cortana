import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { isAppError } from '@cortana/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findToolkit,
  HEIGHT,
  makeSlideshow,
  type PlannedSlide,
  planSlides,
  slideshowArgs,
  WIDTH,
  wrapCaption,
} from './slideshow.ts';
import { createMediaStore } from './store.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cortana-show-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A PNG of one colour, of any size. */
function png(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A caption with everything the filter syntax would read as structure. */
const HOSTILE = "Vízpumpa: kész' [x]; %{eif:1:d} \\ ő";

describe('a caption', () => {
  it('is wrapped at spaces to lines that fit the frame', () => {
    expect(wrapCaption('Kicseréltem a vízpumpát és a termosztátot')).toBe(
      'Kicseréltem a\nvízpumpát és a\ntermosztátot',
    );
  });

  it('breaks a word too long for a line, and is cut after four lines', () => {
    expect(wrapCaption('a'.repeat(30), 22)).toBe(`${'a'.repeat(22)}\n${'a'.repeat(8)}`);
    const long = wrapCaption(Array.from({ length: 30 }, () => 'szó').join(' '));
    expect(long.split('\n')).toHaveLength(4);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('the caption files', () => {
  it('hold each caption already wrapped, and no file for a slide without one', () => {
    const store = createMediaStore({ dir: join(root, 'media') });
    const held = store.put(png(8, 8, [1, 2, 3]));
    const work = mkdtempSync(join(root, 'work-'));

    const planned = planSlides(
      store,
      [
        { id: held.id, seconds: 2, caption: 'Kicseréltem a vízpumpát és a termosztátot' },
        { id: held.id, seconds: 2, caption: '  ' },
      ],
      work,
    );

    expect(readFileSync(planned[0]?.captionFile as string, 'utf8')).toBe(
      'Kicseréltem a\nvízpumpát és a\ntermosztátot',
    );
    expect(planned[1]?.captionFile).toBeNull();
    expect(planned[0]?.path).toBe(store.localPath(held.id));
  });
});

describe('the arguments ffmpeg is given', () => {
  const plan = (captionFile: string | null): PlannedSlide[] => [
    { path: '/store/aaaaaaaaaaaaaaaa.jpg', seconds: 3, captionFile },
    { path: '/store/bbbbbbbbbbbbbbbb.png', seconds: 2.5, captionFile: null },
  ];

  it('carry no caption text — only the file each caption was written to', () => {
    const args = slideshowArgs(
      plan('/tmp/work/caption-0.txt'),
      '/tmp/work/font.ttf',
      '/tmp/work/out.mp4',
    );
    const joined = args.join(' ');

    expect(joined).toContain('textfile=/tmp/work/caption-0.txt');
    expect(joined).toContain('expansion=none');
    for (const fragment of ['Vízpumpa', '%{', "kész'"]) expect(joined).not.toContain(fragment);
  });

  it('make each photo its own input for its own time, and join them in order', () => {
    const args = slideshowArgs(plan(null), null, '/tmp/work/out.mp4');

    expect(args.filter((arg) => arg === '-i')).toHaveLength(2);
    expect(args).toContain('/store/aaaaaaaaaaaaaaaa.jpg');
    expect(args.join(' ')).toContain('-t 3.00');
    expect(args.join(' ')).toContain('-t 2.50');
    expect(args.join(' ')).toContain('[v0][v1]concat=n=2:v=1:a=0[out]');
    expect(args.join(' ')).toContain(`${WIDTH}:${HEIGHT}`);
    expect(args).toContain('-an');
  });

  it('refuse a path in the filtergraph that the syntax could read as structure', () => {
    expect(() =>
      slideshowArgs(plan("/tmp/it's:here.txt"), '/tmp/font.ttf', '/tmp/out.mp4'),
    ).toThrow(/cannot be written into a filtergraph/);
  });
});

const toolkit = findToolkit();
const ffprobe = toolkit.ffmpeg?.replace(/ffmpeg$/, 'ffprobe') ?? null;

describe.skipIf(toolkit.ffmpeg === null || toolkit.font === null)('a real video', () => {
  it('is made from a landscape and a portrait photo, with captions, and kept', async () => {
    const store = createMediaStore({ dir: join(root, 'media') });
    const wide = store.put(png(640, 480, [200, 30, 30]));
    const tall = store.put(png(480, 640, [30, 30, 200]));

    const video = await makeSlideshow({
      store,
      toolkit,
      slides: [
        { id: wide.id, seconds: 1.5, caption: HOSTILE },
        { id: tall.id, seconds: 1, caption: '' },
      ],
    });

    expect(video.mediaType).toBe('video/mp4');
    expect(store.get(video.id)).toEqual(video);
    if (ffprobe !== null) {
      const probed = execFileSync(
        ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_entries',
          'stream=width,height:format=duration',
          '-of',
          'json',
          store.localPath(video.id) as string,
        ],
        { encoding: 'utf8' },
      );
      const info = JSON.parse(probed) as {
        streams: { width: number; height: number }[];
        format: { duration: string };
      };
      expect(info.streams[0]).toEqual({ width: WIDTH, height: HEIGHT });
      expect(Number(info.format.duration)).toBeCloseTo(2.5, 0);
    }
  }, 60_000);
});

describe('a video that cannot be made', () => {
  it('is refused in a sentence when a photo is not held', async () => {
    const store = createMediaStore({ dir: join(root, 'media') });
    const error = await makeSlideshow({
      store,
      toolkit: { ffmpeg: 'ffmpeg', font: null },
      slides: [{ id: '0000000000000000', seconds: 2, caption: '' }],
    }).catch((caught: unknown) => caught);

    expect(isAppError(error) && error.code).toBe('slideshow-unknown-photo');
  });

  it('is refused in a sentence when the machine has no ffmpeg that can caption', async () => {
    const store = createMediaStore({ dir: join(root, 'media') });
    const held = store.put(png(8, 8, [1, 2, 3]));
    const error = await makeSlideshow({
      store,
      toolkit: { ffmpeg: null, font: null },
      slides: [{ id: held.id, seconds: 2, caption: '' }],
    }).catch((caught: unknown) => caught);

    expect(isAppError(error) && error.code).toBe('slideshow-no-ffmpeg');
  });

  it('is not kept when what came out is not a video', () => {
    const store = createMediaStore({ dir: join(root, 'media') });
    writeFileSync(join(root, 'x'), 'x');
    expect(() => store.putVideo(new TextEncoder().encode('not a video at all'))).toThrow(
      /not an MP4/,
    );
  });
});

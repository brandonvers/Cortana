/**
 * Photos into a vertical video: one after another, each for a few seconds,
 * each with an optional caption — assembled by `ffmpeg`, and nothing more.
 *
 * What a finished clip is was decided at the start: assembly from stills the
 * owner took, captions over them, and no sound — sound is added on the
 * platform. 1080×1920 at 30 frames a second, H.264, which every short-video
 * platform takes as it is. A photo that is not 9:16 sits whole in the middle,
 * over a blurred, enlarged copy of itself, rather than being cropped.
 *
 * ## Nothing a model wrote reaches a command line
 *
 * The captions are a model's words, and `ffmpeg`'s filter syntax treats colons,
 * quotes, brackets and backslashes as structure. So a caption never enters the
 * arguments: each one is written to its own file and `drawtext` reads it with
 * `textfile=`, with `expansion=none` so that a `%{…}` in the words stays words.
 * The photos are named by id and turned into paths by the store, the font and
 * the caption files live in a directory this function made, and the arguments
 * are built by a pure function a test reads — so "no model text in argv" is a
 * property checked on every run, not a promise.
 */

import { execFile, execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '@cortana/core';
import type { MediaStore, StoredMedia } from './store.ts';

export const WIDTH = 1080;
export const HEIGHT = 1920;
const FPS = 30;

/** How long one `ffmpeg` run may take before it is stopped. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Characters per caption line, at the size captions are drawn. */
const LINE_WIDTH = 22;
const MAX_LINES = 4;

export interface Slide {
  /** A held image, by id. */
  readonly id: string;
  readonly seconds: number;
  /** Drawn over the lower part of the photo. Empty for none. */
  readonly caption: string;
}

/** One slide as `ffmpeg` is handed it: a path, a duration, and a caption file or none. */
export interface PlannedSlide {
  readonly path: string;
  readonly seconds: number;
  readonly captionFile: string | null;
}

/**
 * A caption, wrapped to lines that fit the frame.
 *
 * `drawtext` draws one line as long as it is given, off the edge if need be,
 * so lines are broken here — at spaces, and inside a word only when the word
 * alone is too long. Past four lines it is cut with an ellipsis: a caption
 * that covers the photo is not a caption.
 */
export function wrapCaption(text: string, width = LINE_WIDTH): string {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '');
  const lines: string[] = [];
  let line = '';
  for (let word of words) {
    while (word.length > width) {
      if (line !== '') {
        lines.push(line);
        line = '';
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  if (lines.length <= MAX_LINES) return lines.join('\n');
  const kept = lines.slice(0, MAX_LINES);
  kept[MAX_LINES - 1] = `${(kept[MAX_LINES - 1] ?? '').slice(0, width - 1)}…`;
  return kept.join('\n');
}

/**
 * A path that may be written into a filtergraph as it is.
 *
 * Only paths this module made go there — a font copy and caption files in its
 * own temporary directory — and they are held to characters the filter syntax
 * gives no meaning to. A path outside that set is refused, not escaped: an
 * escaping rule that is wrong once is a filter injected.
 */
function filterPath(path: string): string {
  if (!/^[A-Za-z0-9_./-]+$/.test(path)) {
    throw new Error(`"${path}" cannot be written into a filtergraph safely`);
  }
  return path;
}

/**
 * The arguments for one run, as a pure function a test can read.
 *
 * Every photo is its own looped input, scaled whole into the frame over a
 * blurred copy that fills it, given its caption, and the slides are joined in
 * order.
 */
export function slideshowArgs(
  slides: readonly PlannedSlide[],
  font: string | null,
  out: string,
): string[] {
  const inputs = slides.flatMap((slide) => [
    '-loop',
    '1',
    '-framerate',
    String(FPS),
    '-t',
    slide.seconds.toFixed(2),
    '-i',
    slide.path,
  ]);

  const chains = slides.map((slide, at) => {
    const steps = [
      `[${at}:v]split=2[back${at}][front${at}]`,
      `[back${at}]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},boxblur=24:2,setsar=1[blur${at}]`,
      `[front${at}]scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease,setsar=1[fit${at}]`,
    ];
    let frame = `[blur${at}][fit${at}]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p`;
    if (slide.captionFile !== null) {
      if (font === null) throw new Error('a caption needs a font');
      frame +=
        `,drawtext=fontfile=${filterPath(font)}:textfile=${filterPath(slide.captionFile)}` +
        ':expansion=none:text_align=C:fontsize=64:fontcolor=white:line_spacing=14' +
        ':box=1:boxcolor=black@0.55:boxborderw=28:x=(w-text_w)/2:y=h*0.72-text_h/2';
    }
    steps.push(`${frame},trim=duration=${slide.seconds.toFixed(2)},setpts=PTS-STARTPTS[v${at}]`);
    return steps.join(';');
  });

  const joined = `${slides.map((_, at) => `[v${at}]`).join('')}concat=n=${slides.length}:v=1:a=0[out]`;

  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    ...inputs,
    '-filter_complex',
    [...chains, joined].join(';'),
    '-map',
    '[out]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(FPS),
    '-movflags',
    '+faststart',
    '-an',
    '-y',
    out,
  ];
}

/** Where this machine's tools are, found once. */
export interface Toolkit {
  /** An `ffmpeg` that can draw text, or null. */
  readonly ffmpeg: string | null;
  /** A bold font with the accents Hungarian needs, or null. */
  readonly font: string | null;
}

const FFMPEG_CANDIDATES = [
  'ffmpeg',
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  // Homebrew's plain `ffmpeg` is built without `drawtext`; its fuller one is not.
  '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
];
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/Library/Fonts/Arial Bold.ttf',
];

/**
 * The first `ffmpeg` that can draw captions, and the first usable font.
 *
 * Checked rather than assumed: a build without `drawtext` fails only when a
 * caption is drawn, after the photos were decoded, with a message about a
 * filter rather than about the build. Asking it which filters it has costs a
 * fraction of a second, once.
 */
export function findToolkit(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Toolkit {
  const wanted = env['CORTANA_FFMPEG'];
  const candidates = wanted ? [wanted] : FFMPEG_CANDIDATES;
  let ffmpeg: string | null = null;
  for (const candidate of candidates) {
    try {
      const filters = execFileSync(candidate, ['-hide_banner', '-filters'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      });
      if (/\sdrawtext\s/.test(filters)) {
        ffmpeg = candidate;
        break;
      }
    } catch {
      // Not there, or not runnable: the next one.
    }
  }
  const font = FONT_CANDIDATES.find((path) => existsSync(path)) ?? null;
  return { ffmpeg, font };
}

/**
 * The slides as `ffmpeg` will be handed them: each photo's path, and each
 * caption written — wrapped — to its own file in `work`.
 *
 * Separate so that what a caption file holds can be checked: an unwrapped
 * caption still makes a video, and runs off the edge of it.
 */
export function planSlides(
  store: MediaStore,
  slides: readonly Slide[],
  work: string,
): PlannedSlide[] {
  return slides.map((slide, at) => {
    let captionFile: string | null = null;
    if (slide.caption.trim() !== '') {
      captionFile = join(work, `caption-${at}.txt`);
      writeFileSync(captionFile, wrapCaption(slide.caption), 'utf8');
    }
    return { path: store.localPath(slide.id) as string, seconds: slide.seconds, captionFile };
  });
}

/**
 * Makes the video and keeps it, or says in a sentence why it could not.
 *
 * Every refusal is an `AppError` written to be read: the action that calls
 * this hands its message to the agent, which tells the person.
 */
export async function makeSlideshow(options: {
  readonly store: MediaStore;
  readonly slides: readonly Slide[];
  readonly toolkit: Toolkit;
  readonly timeoutMs?: number;
}): Promise<StoredMedia> {
  const { store, slides, toolkit } = options;
  const refuse = (message: string, code: string) =>
    new AppError(message, { category: 'contract', code });

  if (toolkit.ffmpeg === null) {
    throw refuse(
      'this machine has no ffmpeg that can draw captions, so no video can be made here',
      'slideshow-no-ffmpeg',
    );
  }
  const unknown = slides.filter(
    (slide) => store.get(slide.id)?.mediaType.startsWith('image/') !== true,
  );
  if (unknown.length > 0) {
    throw refuse(
      `there is no photo held as ${unknown.map((slide) => slide.id).join(', ')}`,
      'slideshow-unknown-photo',
    );
  }
  const captioned = slides.some((slide) => slide.caption.trim() !== '');
  if (captioned && toolkit.font === null) {
    throw refuse('this machine has no font to draw captions with', 'slideshow-no-font');
  }

  const work = mkdtempSync(join(tmpdir(), 'cortana-slides-'));
  try {
    // The font is copied into the working directory so that its path is one
    // this module made and can vouch for, whatever the system's is called.
    const font = captioned && toolkit.font !== null ? join(work, 'font.ttf') : null;
    if (font !== null && toolkit.font !== null) copyFileSync(toolkit.font, font);

    const planned = planSlides(store, slides, work);

    const out = join(work, 'out.mp4');
    await new Promise<void>((resolve, reject) => {
      execFile(
        toolkit.ffmpeg as string,
        slideshowArgs(planned, font, out),
        { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (error === null) return resolve();
          const timedOut = (error as { killed?: boolean }).killed === true;
          reject(
            new AppError(
              timedOut
                ? 'making the video took too long and was stopped'
                : `ffmpeg could not make the video: ${String(stderr).trim().split('\n').at(-1) ?? 'no reason given'}`,
              {
                category: timedOut ? 'timeout' : 'internal',
                code: timedOut ? 'slideshow-timed-out' : 'slideshow-failed',
              },
            ),
          );
        },
      );
    });

    return store.putVideo(readFileSync(out));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

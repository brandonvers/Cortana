/**
 * Photos and clips into a vertical video: one after another, each for a few
 * seconds, each with an optional caption — assembled by `ffmpeg`, and nothing
 * more.
 *
 * What a finished video is was decided at the start: assembly from what the
 * owner shot, captions over it, and no sound — sound is added on the platform,
 * so a clip's own is dropped. 1080×1920 at 30 frames a second, H.264, which
 * every short-video platform takes as it is. A photo or clip that is not 9:16
 * sits whole in the middle, over a blurred, enlarged copy of itself, rather
 * than being cropped. A clip is cut: a stretch of it, from a given second, for
 * the slide's seconds.
 *
 * ## Nothing a model wrote reaches a command line
 *
 * The captions are a model's words, and `ffmpeg`'s filter syntax treats colons,
 * quotes, brackets and backslashes as structure. So a caption never enters the
 * arguments: each one is written to its own file and `drawtext` reads it with
 * `textfile=`, with `expansion=none` so that a `%{…}` in the words stays words.
 * The photos and clips are named by id and turned into paths by the store, the font and
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
import { dirname, join } from 'node:path';
import { AppError } from '@cortana/core';
import { type MediaStore, type StoredMedia, VIDEO_TYPE } from './store.ts';
import { measureVideo } from './video.ts';

export const WIDTH = 1080;
export const HEIGHT = 1920;
const FPS = 30;

/** The longest a photo is held, and the longest stretch of one clip, in seconds. */
export const MAX_PHOTO_SECONDS = 10;
export const MAX_CLIP_SECONDS = 30;

/** How long one `ffmpeg` run may take before it is stopped. */
const DEFAULT_TIMEOUT_MS = 180_000;

/** Characters per caption line, at the size captions are drawn. */
const LINE_WIDTH = 22;
const MAX_LINES = 4;

export interface Slide {
  /** A held image or video, by id. */
  readonly id: string;
  readonly seconds: number;
  /** Drawn over the lower part of the frame. Empty for none. */
  readonly caption: string;
  /** For a clip, the second its stretch starts at. Ignored for a photo. */
  readonly from?: number;
}

/**
 * One slide as `ffmpeg` is handed it: a path, a duration, a caption file or
 * none — and, for a clip, where in it to start.
 */
export interface PlannedSlide {
  readonly path: string;
  readonly seconds: number;
  readonly captionFile: string | null;
  /** Set for a clip, and only for one: the second its stretch starts at. */
  readonly from?: number;
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
 * Every photo is its own looped input and every clip its own cut one, each
 * scaled whole into the frame over a blurred copy that fills it, given its
 * caption, and the slides are joined in order. Only video is mapped out, so a
 * clip's sound goes nowhere.
 */
export function slideshowArgs(
  slides: readonly PlannedSlide[],
  font: string | null,
  out: string,
): string[] {
  const inputs = slides.flatMap((slide) =>
    slide.from === undefined
      ? ['-loop', '1', '-framerate', String(FPS), '-t', slide.seconds.toFixed(2), '-i', slide.path]
      : ['-ss', slide.from.toFixed(2), '-t', slide.seconds.toFixed(2), '-i', slide.path],
  );

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
  /** The `ffprobe` beside it, which measures a clip, or null. */
  readonly ffprobe: string | null;
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
  return { ffmpeg, ffprobe: ffprobeBeside(ffmpeg), font };
}

/**
 * The `ffprobe` that came with this `ffmpeg`: the same directory, or the
 * search path when `ffmpeg` was found there. A different build's would measure
 * the same file, but one install is one thing to reason about.
 */
function ffprobeBeside(ffmpeg: string | null): string | null {
  if (ffmpeg === null) return null;
  const candidate = ffmpeg.includes('/') ? join(dirname(ffmpeg), 'ffprobe') : 'ffprobe';
  try {
    execFileSync(candidate, ['-version'], { stdio: 'ignore', timeout: 10_000 });
    return candidate;
  } catch {
    return null;
  }
}

/**
 * The slides as `ffmpeg` will be handed them: each photo's or clip's path,
 * where a clip starts, and each caption written — wrapped — to its own file in
 * `work`.
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
    const path = store.localPath(slide.id) as string;
    // A clip by what the store holds it as, never by whether `from` was given.
    return store.get(slide.id)?.mediaType === VIDEO_TYPE
      ? { path, seconds: slide.seconds, captionFile, from: slide.from ?? 0 }
      : { path, seconds: slide.seconds, captionFile };
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
  const unknown = slides.filter((slide) => store.localPath(slide.id) === null);
  if (unknown.length > 0) {
    throw refuse(
      `there is no photo or clip held as ${unknown.map((slide) => slide.id).join(', ')}`,
      'slideshow-unknown-file',
    );
  }
  // A stretch past a clip's end would make a shorter video than the one the
  // agent described, silently. Measured, and said with the clip's length, so
  // the agent can ask again with a stretch that fits.
  for (const slide of slides) {
    if (store.get(slide.id)?.mediaType !== VIDEO_TYPE) {
      if (slide.seconds > MAX_PHOTO_SECONDS) {
        throw refuse(
          `a photo is shown for at most ${MAX_PHOTO_SECONDS} seconds, and ${slide.id} was given ${slide.seconds}`,
          'slideshow-photo-too-long',
        );
      }
      continue;
    }
    if (slide.seconds > MAX_CLIP_SECONDS) {
      throw refuse(
        `one stretch of a clip is at most ${MAX_CLIP_SECONDS} seconds, and ${slide.id} was given ${slide.seconds}`,
        'slideshow-clip-too-long',
      );
    }
    if (toolkit.ffprobe === null) {
      throw refuse(
        'this machine has no ffprobe to measure a clip with, so clips cannot be used here',
        'slideshow-no-ffprobe',
      );
    }
    const length = await measureVideo(toolkit, store.localPath(slide.id) as string);
    const from = slide.from ?? 0;
    if (from + slide.seconds > length + 0.05) {
      throw refuse(
        `the clip ${slide.id} is ${length.toFixed(1)} seconds long, so it has no ` +
          `${slide.seconds} seconds starting at ${from} s`,
        'slideshow-clip-too-short',
      );
    }
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

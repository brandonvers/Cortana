/**
 * What the system itself says to a person, in their language.
 *
 * Not what the agent says — the model answers in whatever language it is
 * spoken to. These are the sentences no model writes: a refusal of a forwarded
 * message, an approval's buttons, the note that a file could not be sent. Said
 * in English to someone who speaks Hungarian, they are the one part of a
 * conversation in the wrong language, and the part that explains what went
 * wrong.
 *
 * What the agent is told — an action's result, a refusal note — stays in
 * English: the model reads it and answers the person in theirs.
 */

import type { ToolRequest } from '@cortana/policy';

export const LANGUAGES = ['en', 'hu'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Phrasebook {
  readonly forwardedRefusal: string;
  /** What was sent that is not passed on: voice, and files that are not media. */
  readonly notPassedOn: string;
  readonly mediaNotFetched: string;
  readonly turnFailed: string;
  readonly fileNotSent: (id: string) => string;
  readonly emptyReply: string;
  readonly allow: string;
  readonly refuse: string;
  readonly allowed: string;
  readonly refused: string;
  readonly unanswered: string;
  readonly closed: string;
  readonly stale: string;
  /** An approval's question, composed from the request rather than from anything a model wrote. */
  readonly question: (request: ToolRequest) => string;
  readonly startedOver: string;
  readonly notHeld: (ids: readonly string[]) => string;
  /** A file the store would not keep, by the store's code; `said` is the store's own words. */
  readonly fileRefused: (code: string, said: string) => string;
}

const en: Phrasebook = {
  forwardedRefusal:
    'A forwarded message is somebody else’s words, and it would reach the agent as ' +
    'though you had written them. That is not allowed yet — copy the part you mean ' +
    'into a message of your own.',
  notPassedOn:
    'Text and photos reach the agent; voice, video and other files are not passed on yet.',
  mediaNotFetched:
    'A photo could not be fetched from Telegram, so nothing was sent to the agent. ' +
    'Try sending it again.',
  turnFailed: 'Something went wrong answering that. The details are in the log.',
  fileNotSent: (id) => `A file that came with the answer could not be sent. (${id})`,
  emptyReply: 'The agent finished without saying anything.',
  allow: 'Allow',
  refuse: 'Refuse',
  allowed: 'Allowed.',
  refused: 'Refused.',
  unanswered: 'No answer, so refused.',
  closed: 'The daemon stopped before this was answered, so it was refused.',
  stale: 'That question is no longer open.',
  question: (request) => {
    const verb = request.writes === true ? 'write' : 'use';
    const target = request.path === undefined ? '' : ` on ${request.path}`;
    const reach = request.network === true ? ', reaching the network' : '';
    return `The agent wants to ${verb} ${request.tool}${target}${reach}. Allow it?`;
  },
  startedOver: 'Started a new conversation. What was said before is no longer carried forward.',
  notHeld: (ids) => `\n\n(Not sent: the system holds no file called ${ids.join(', ')}.)`,
  fileRefused: (_code, said) => said,
};

const hu: Phrasebook = {
  forwardedRefusal:
    'Egy továbbított üzenet valaki más szavait hozza, és úgy érne el az agenthez, mintha ' +
    'te írtad volna. Ezt egyelőre nem engedem — másold át a lényeget egy saját üzenetbe.',
  notPassedOn: 'Szöveg és fotó jut el az agenthez; hangüzenet, videó és más fájl egyelőre nem.',
  mediaNotFetched:
    'Egy fotót nem sikerült letölteni a Telegramról, így semmi nem ment az agentnek. ' +
    'Küldd el újra.',
  turnFailed: 'Valami hiba történt a válasz közben. A részletek a naplóban vannak.',
  fileNotSent: (id) => `Egy fájlt nem sikerült elküldeni a válasz mellé. (${id})`,
  emptyReply: 'Az agent nem írt választ.',
  allow: 'Engedélyezem',
  refuse: 'Elutasítom',
  allowed: 'Engedélyezve.',
  refused: 'Elutasítva.',
  unanswered: 'Nem jött válasz, ezért elutasítva.',
  closed: 'A rendszer leállt, mielőtt válaszoltál volna, ezért elutasítva.',
  stale: 'Ez a kérdés már nincs nyitva.',
  question: (request) => {
    const target = request.path === undefined ? '' : ` (${request.path})`;
    const reach = request.network === true ? ', a hálózatot is elérve' : '';
    return request.writes === true
      ? `Az agent írni szeretne ezzel: ${request.tool}${target}${reach}. Engedélyezed?`
      : `Az agent használni szeretné ezt: ${request.tool}${target}${reach}. Engedélyezed?`;
  },
  startedOver: 'Új beszélgetést kezdtem. Ami eddig elhangzott, azt innentől nem viszem tovább.',
  notHeld: (ids) => `\n\n(Nem ment el: a rendszer nem tárol ilyen nevű fájlt: ${ids.join(', ')}.)`,
  fileRefused: (code, said) =>
    ({
      'media-not-an-image':
        'Ez nem olyan kép, amit a rendszer használni tud (JPEG, PNG, WebP vagy GIF).',
      'media-not-a-video': 'Ez nem olyan videó, amit a rendszer használni tud (MP4).',
      'media-too-large': 'Ez a fájl túl nagy ahhoz, hogy az agent megkapja.',
    })[code] ?? said,
};

export const PHRASES: Readonly<Record<Language, Phrasebook>> = { en, hu };

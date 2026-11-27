/** Select a single source-bound answer for optional local AI tooling.
 * This is ephemeral UI routing, not an imported or saved answer format.
 */
import type { Answer } from './pdfChatCore';
import { MAX_CHAT_TURNS, type ChatTurn } from './pdfChatSession';
import { MAX_SUBQUESTIONS } from './pdfChatInsights';

export type AnswerTarget = {
  id: string;
  turnIndex: number;
  partIndex: number;
  parts: number;
  answer: Answer;
};
function invalid(): never { throw new Error('Invalid chat answer target.'); }
export function answerTargets(turns: readonly ChatTurn[]): AnswerTarget[] {
  if (!Array.isArray(turns) || turns.length > MAX_CHAT_TURNS) invalid();
  const targets: AnswerTarget[] = [];
  turns.forEach((turn, turnIndex) => {
    if (!Array.isArray(turn.answers) || !turn.answers.length || turn.answers.length > MAX_SUBQUESTIONS) invalid();
    turn.answers.forEach((answer: Answer, partIndex: number) => {
      if (!answer || typeof answer.question !== 'string' || !answer.question.trim() ||
          !['original', 'revised', 'both'].includes(answer.scope)) invalid();
      targets.push({ id: turnIndex + ':' + partIndex, turnIndex, partIndex, parts: turn.answers.length, answer });
    });
  });
  return targets;
}
/** A stale explicit target fails closed. Null selects the first answer
 * of the latest turn, never a merged set of subquestion citations.
 */
export function selectAnswerTarget(targets: readonly AnswerTarget[], id: string | null): AnswerTarget | null {
  if (!targets.length) return null;
  if (id !== null) return targets.find(target => target.id === id) ?? null;
  const latestTurn = targets[targets.length - 1].turnIndex;
  return targets.find(target => target.turnIndex === latestTurn && target.partIndex === 0) ?? null;
}
export function answerTargetLabel(target: AnswerTarget): string {
  const prefix = 'Question ' + (target.turnIndex + 1) +
    (target.parts > 1 ? ', part ' + (target.partIndex + 1) + ' of ' + target.parts : '');
  const scope = target.answer.scope === 'both' ? 'both PDFs' : target.answer.scope + ' PDF';
  const page = target.answer.pageFilter === undefined ? '' : ', physical page ' + target.answer.pageFilter;
  const text = target.answer.question.replace(/\s+/g, ' ').trim();
  return prefix + ' — ' + (text.length <= 96 ? text : text.slice(0, 95) + '…') + ' (' + scope + page + ')';
}

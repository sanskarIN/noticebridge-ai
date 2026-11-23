import type { Finding } from './comparison';

type ReviewPriority = {
  id: string;
  rank: number;
  title: string;
  detail: string;
};

function describeFinding(finding: Finding): ReviewPriority | undefined {
  const { id, status, category } = finding;
  const clockPriority = describeClockFinding(finding);
  if (clockPriority) return clockPriority;
  if (status === 'contradiction') {
    return { id, rank: 0, title: 'Conflicting dates', detail: 'Check both dates in the same PDF.' };
  }
  const delta = finding.field_changes.find(change => change.outcome === 'changed');
  if (status === 'confirmed_change' && category === 'deadline' && delta?.kind === 'date' &&
      delta.original.canonical && delta.revised.canonical) {
    const days = (Date.parse(delta.revised.canonical) - Date.parse(delta.original.canonical)) / 86_400_000;
    if (Number.isSafeInteger(days) && days !== 0) {
      const count = Math.abs(days);
      return {
        id, rank: days < 0 ? 1 : 3,
        title: `Deadline moved ${count} day${count === 1 ? '' : 's'} ${days < 0 ? 'earlier' : 'later'}`,
        detail: `${delta.original.raw} → ${delta.revised.raw}`,
      };
    }
  }
  if (category === 'deadline' && finding.field_changes.some(change => change.outcome === 'uncertain')) {
    return {
      id, rank: 2,
      title: finding.match_method === 'explicit_amendment'
        ? 'Deadline amendment needs verification' : 'Deadline needs verification',
      detail: 'Inspect the quoted dates and confirm the intended date with the issuer.',
    };
  }
  if (status === 'confirmed_change' && category === 'fee' && delta?.kind === 'amount') {
    return { id, rank: 4, title: 'Fee changed', detail: `${delta.original.raw} → ${delta.revised.raw}` };
  }
  if (category === 'fee' && finding.match_method === 'explicit_amendment') {
    return { id, rank: 5, title: 'Fee amendment needs verification', detail: 'Check the quoted amounts in both notices.' };
  }
  return undefined;
}

export function reviewPriorities(
  findings: Finding[], reviewable: ReadonlySet<string>, checked: ReadonlySet<string>,
): ReviewPriority[] {
  return findings.flatMap(finding => {
    if (checked.has(finding.id) || !reviewable.has(finding.id)) return [];
    return describeFinding(finding) ?? [];
  }).sort((first, second) => first.rank - second.rank).slice(0, 3);
}

function describeClockFinding(finding: Finding): ReviewPriority | undefined {
  const { id, category, field_changes: values } = finding;
  const clock = values.find(change => change.kind === 'time');
  if (!clock || clock.outcome === 'same_value') return undefined;

  const calendar = values.find(change => change.kind === 'date');
  if (calendar?.outcome === 'changed' && clock.outcome === 'changed') {
    // Crossing a calendar date can move a cutoff by only a few minutes.
    return {
      id, rank: 1, title: 'Deadline date and time changed',
      detail: `${calendar.original.raw} at ${clock.original.raw} → ` +
        `${calendar.revised.raw} at ${clock.revised.raw}`,
    };
  }

  const isDeadline = category === 'deadline';
  if (clock.outcome === 'changed' && calendar?.outcome !== 'uncertain') {
    return {
      id, rank: isDeadline ? 1 : 5,
      title: isDeadline ? 'Deadline time changed' : 'Scheduled time changed',
      detail: `${clock.original.raw} → ${clock.revised.raw}`,
    };
  }

  const usesOcr = [finding.original, finding.revised].some(source => source?.extraction_method === 'ocr');
  return {
    id, rank: isDeadline ? 2 : 5,
    title: isDeadline ? 'Deadline needs verification' : 'Scheduled time needs verification',
    detail: usesOcr
      ? 'Check the machine transcription against the source PDF and verify the intended time.'
      : 'Inspect the quoted passages and confirm the intended date and time with the issuer.',
  };
}

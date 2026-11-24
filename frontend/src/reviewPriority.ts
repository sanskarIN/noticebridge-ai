import type { Finding } from './comparison';

type ReviewPriority = {
  id: string;
  rank: number;
  title: string;
  detail: string;
};

const UNCERTAIN_SOURCE =
  'Inspect the quoted passages and verify the intended requirement with the issuer.';
const OCR_CAUTION = ' OCR transcription must be checked against the original PDF page.';

function sourceCaution(finding: Finding): string {
  const sources = [finding.original, finding.revised, ...finding.supporting_evidence];
  return sources.some(source => source?.extraction_method === 'ocr') ? OCR_CAUTION : '';
}

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
        id, rank: days < 0 ? 1 : 4,
        title: 'Deadline moved ' + count + ' day' + (count === 1 ? '' : 's') +
          (days < 0 ? ' earlier' : ' later'),
        detail: delta.original.raw + ' → ' + delta.revised.raw,
      };
    }
  }

  if (category === 'deadline') {
    if (finding.match_method === 'explicit_amendment') {
      return {
        id, rank: 2, title: 'Deadline amendment needs verification',
        detail: 'The updated PDF states an amendment; confirm it with the issuer.',
      };
    }
    if (finding.field_changes.some(change => change.outcome === 'uncertain')) {
      return {
        id, rank: 2, title: 'Deadline needs verification',
        detail: 'Inspect the quoted dates and confirm the intended date with the issuer.' +
          sourceCaution(finding),
      };
    }
    if (status === 'missing_information') {
      return {
        id, rank: 3, title: 'Unmatched deadline statement',
        detail: 'A deadline appears in only one PDF. Do not assume it was added or withdrawn.' +
          sourceCaution(finding),
      };
    }
    if (status === 'possible_change') {
      return {
        id, rank: 3, title: 'Possible deadline wording change',
        detail: 'The source wording may differ without a reliably parsed date. ' +
          UNCERTAIN_SOURCE + sourceCaution(finding),
      };
    }
  }

  if (status === 'confirmed_change' && category === 'fee' && delta?.kind === 'amount') {
    return { id, rank: 5, title: 'Fee changed', detail: delta.original.raw + ' → ' + delta.revised.raw };
  }
  if (category === 'fee' && finding.match_method === 'explicit_amendment') {
    return {
      id, rank: 6, title: 'Fee amendment needs verification',
      detail: 'Check the quoted amounts in both notices.',
    };
  }
  if (category === 'fee' && status === 'missing_information') {
    return {
      id, rank: 6, title: 'Unmatched fee statement',
      detail: 'A fee statement appears in only one PDF. Confirm the applicable fee with the issuer.' +
        sourceCaution(finding),
    };
  }
  if (category === 'fee' && status === 'possible_change') {
    return {
      id, rank: 6, title: 'Possible fee wording change',
      detail: UNCERTAIN_SOURCE + sourceCaution(finding),
    };
  }
  if (category === 'eligibility') {
    return {
      id, rank: 7,
      title: status === 'missing_information' ? 'Unmatched eligibility statement' : 'Eligibility needs review',
      detail: 'Do not infer eligibility or an exemption from the wording match. ' +
        UNCERTAIN_SOURCE + sourceCaution(finding),
    };
  }
  if ((category === 'time' || category === 'instruction') &&
      (status === 'possible_change' || status === 'missing_information')) {
    return {
      id, rank: 8,
      title: category === 'time' ? 'Schedule needs review' : 'Instructions need review',
      detail: UNCERTAIN_SOURCE + sourceCaution(finding),
    };
  }
  return undefined;
}

export function reviewPriorities(
  findings: Finding[], reviewable: ReadonlySet<string>, checked: ReadonlySet<string>,
): ReviewPriority[] {
  return findings.flatMap(finding => {
    if (checked.has(finding.id) || !reviewable.has(finding.id)) return [];
    return describeFinding(finding) ?? [];
  }).sort((first, second) => first.rank - second.rank);
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

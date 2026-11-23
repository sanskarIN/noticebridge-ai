import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import type { Language, Report } from './comparison';
import { restoreReviewSelections } from './restoreReview';

const MAX_REPORT_BYTES = 64 * 1024 * 1024;

const copy = {
  en: {
    action: 'Restore checklist from JSON',
    reading: 'Checking saved report…',
    help: 'Compare the same two PDFs in the same order, then choose an exported evidence report.',
    invalid: 'Choose a NoticeBridge evidence report in JSON format, up to 64 MiB.',
    differentSources: 'This report is for a different PDF pair or upload order.',
    changedFindings: 'The current comparison produced different findings for the saved selections. Try the original settings or review the current findings.',
    complete: (count: number) => count === 0
      ? 'The saved report contains no checklist selections.'
      : `Loaded ${count} saved checklist selection${count === 1 ? '' : 's'}.`,
  },
  hi: {
    action: 'JSON से समीक्षा चयन वापस लाएँ',
    reading: 'सहेजी गई रिपोर्ट की जाँच जारी है…',
    help: 'उन्हीं दो PDF को उसी क्रम में तुलना करें, फिर डाउनलोड की गई प्रमाण रिपोर्ट चुनें।',
    invalid: 'NoticeBridge की JSON प्रमाण रिपोर्ट चुनें (अधिकतम 64 MiB)।',
    differentSources: 'यह रिपोर्ट अलग PDF फ़ाइलों या अपलोड क्रम की है।',
    changedFindings: 'सहेजे गए चयन मौजूदा प्रमाण से मेल नहीं खाते। पहले वाले विकल्पों से तुलना करें या मौजूदा निष्कर्षों की समीक्षा करें।',
    complete: (count: number) => count === 0
      ? 'सहेजी गई रिपोर्ट में कोई समीक्षा चयन नहीं है।'
      : `${count} सहेजे गए समीक्षा चयन वापस आ गए।`,
  },
};

type Feedback =
  | { kind: 'invalid' | 'differentSources' | 'changedFindings' }
  | { kind: 'complete'; count: number };

export default function ReviewRestore({ report, language, onRestore }: {
  report: Report;
  language: Language;
  onRestore: (ids: string[]) => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [reading, setReading] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const t = copy[language];

  useEffect(() => () => { generation.current += 1; }, [report]);

  async function importReport(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!selected) return;
    const id = ++generation.current;
    if (selected.size === 0 || selected.size > MAX_REPORT_BYTES) {
      setFeedback({ kind: 'invalid' });
      return;
    }
    setReading(true);
    setFeedback(null);
    try {
      const text = await selected.text();
      if (generation.current !== id) return;
      const raw: unknown = JSON.parse(text);
      const result = restoreReviewSelections(raw, report);
      if ('error' in result) {
        setFeedback({ kind: result.error });
      } else {
        onRestore(result.ids);
        setFeedback({ kind: 'complete', count: result.ids.length });
      }
    } catch {
      if (generation.current === id) setFeedback({ kind: 'invalid' });
    } finally {
      if (generation.current === id) setReading(false);
    }
  }

  return <div className="review-restore">
    <button type="button" className="export-button" disabled={reading}
      aria-describedby="review-restore-help" onClick={() => fileInput.current?.click()}>
      {reading ? t.reading : t.action}
    </button>
    <input type="file" ref={fileInput} hidden aria-label={t.action}
      accept=".json,application/json" onChange={importReport} />
    <p id="review-restore-help">{t.help}</p>
    {feedback && <p className="restore-feedback" role="status">
      {feedback.kind === 'complete' ? t.complete(feedback.count) : t[feedback.kind]}
    </p>}
  </div>;
}

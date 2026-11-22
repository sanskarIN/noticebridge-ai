import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

// Bundle PDF.js and its matching worker with the application. No external CDN
// receives the user's local document or its extracted evidence.
GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfEvidence = {
  page: number;
  bbox: [number, number, number, number];
  page_width: number;
  page_height: number;
  page_rotation: 0 | 90 | 180 | 270;
};

export default function PdfEvidencePreview({ file, evidence, language }: {
  file: File;
  evidence: PdfEvidence;
  language: 'en' | 'hi';
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    let pdf: PDFDocumentProxy | null = null;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setState('loading');
    setError('');

    async function render() {
      try {
        // File.arrayBuffer() never sends the document to an external service.
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (disposed) return;
        const loadTask = getDocument({
          data: bytes,
          isEvalSupported: false,
          disableAutoFetch: true,
          disableStream: true,
        });
        pdf = await loadTask.promise;
        if (disposed) return;
        if (evidence.page < 1 || evidence.page > pdf.numPages) {
          throw new Error('Evidence page is outside the source PDF.');
        }
        const page = await pdf.getPage(evidence.page);
        if (disposed) return;
        const unscaled = page.getViewport({ scale: 1 });
        // Keep a single-page preview comfortably within reasonable canvas size.
        const scale = Math.min(1.5, Math.sqrt(9_000_000 /
          Math.max(1, unscaled.width * unscaled.height)));
        const viewport = page.getViewport({ scale });
        const context = canvas?.getContext('2d');
        if (!canvas || !context) throw new Error('Canvas rendering is unavailable.');
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.max(1, Math.round(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.round(viewport.height * pixelRatio));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (!disposed) setState('ready');
      } catch (cause) {
        if (!disposed) {
          setError(cause instanceof Error ? cause.message : 'Unable to render the source PDF.');
          setState('error');
        }
      }
    }
    void render();
    return () => {
      disposed = true;
      renderTask?.cancel();
      if (pdf) void pdf.destroy();
    };
  }, [file, evidence.page]);

  const canHighlight = evidence.page_rotation === 0 &&
    evidence.page_width > 0 && evidence.page_height > 0 &&
    evidence.bbox.every(Number.isFinite);
  const [x0, y0, x1, y1] = evidence.bbox;
  const left = Math.max(0, Math.min(evidence.page_width, x0));
  const top = Math.max(0, Math.min(evidence.page_height, y0));
  const right = Math.max(left, Math.min(evidence.page_width, x1));
  const bottom = Math.max(top, Math.min(evidence.page_height, y1));
  const markerStyle = {
    left: `${100 * left / evidence.page_width}%`,
    top: `${100 * top / evidence.page_height}%`,
    width: `${100 * (right - left) / evidence.page_width}%`,
    height: `${100 * (bottom - top) / evidence.page_height}%`,
  };

  return <div className="pdf-preview-body">
    {state === 'loading' && <p role="status">{language === 'hi' ? 'PDF पृष्ठ तैयार हो रहा है…' : 'Rendering PDF page…'}</p>}
    {state === 'error' && <p role="alert" className="error-banner">{error}</p>}
    <div className="pdf-stage" aria-label={language === 'hi' ? 'स्रोत PDF पृष्ठ' : 'Source PDF page'}>
      <div className="pdf-canvas-holder">
        <canvas ref={canvasRef} />
        {state === 'ready' && canHighlight && right > left && bottom > top &&
          <div className="evidence-highlight" style={markerStyle} aria-hidden="true" />}
      </div>
    </div>
    <p className="preview-help">{
      canHighlight
        ? language === 'hi'
          ? 'स्रोत निर्देशांकों का हाइलाइट केवल समीक्षा में सहायता करता है; पाठ और पृष्ठ स्वयं जाँचें।'
          : 'Highlight uses extracted source coordinates. Inspect the original text and page before relying on it.'
        : language === 'hi'
          ? 'घुमाए गए पृष्ठ के लिए सटीक बॉक्स हाइलाइट उपलब्ध नहीं है; स्रोत पृष्ठ स्वयं देखें।'
          : 'Exact highlight is unavailable on rotated pages; inspect the rendered source page.'
    }</p>
  </div>;
}

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
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


/**
 * PyMuPDF gives text boxes in unrotated, cropped, top-left page points.
 * PDF.js uses bottom-left PDF user space plus a viewport transformation.
 * Convert both corners through PDF.js, which handles /Rotate and /CropBox;
 * account for /UserUnit and reject geometry mismatches instead of guessing.
 */
function highlightForPage(
  page: PDFPageProxy,
  viewport: ReturnType<PDFPageProxy['getViewport']>,
  evidence: PdfEvidence,
): CSSProperties | null {
  const base = page.getViewport({ scale: 1 });
  const tolerance = 2;
  if (
    page.rotate !== evidence.page_rotation ||
    !Number.isFinite(evidence.page_width) ||
    !Number.isFinite(evidence.page_height) ||
    evidence.page_width <= 0 || evidence.page_height <= 0 ||
    Math.abs(base.width - evidence.page_width) > tolerance ||
    Math.abs(base.height - evidence.page_height) > tolerance ||
    !Number.isFinite(page.userUnit) || page.userUnit <= 0 ||
    !evidence.bbox.every(Number.isFinite)
  ) return null;

  const [x0, y0, x1, y1] = evidence.bbox;
  const unrotatedWidth = page.rotate % 180 === 0 ? evidence.page_width : evidence.page_height;
  const unrotatedHeight = page.rotate % 180 === 0 ? evidence.page_height : evidence.page_width;
  if (
    x0 >= x1 || y0 >= y1 ||
    x0 < -tolerance || y0 < -tolerance ||
    x1 > unrotatedWidth + tolerance || y1 > unrotatedHeight + tolerance
  ) return null;

  const xMin = Math.max(0, x0);
  const yMin = Math.max(0, y0);
  const xMax = Math.min(unrotatedWidth, x1);
  const yMax = Math.min(unrotatedHeight, y1);
  if (xMax <= xMin || yMax <= yMin) return null;

  const [cropLeft, , , cropTop] = page.view;
  const unit = page.userUnit;
  const rectangle = viewport.convertToViewportRectangle([
    cropLeft + xMin / unit, cropTop - yMin / unit,
    cropLeft + xMax / unit, cropTop - yMax / unit,
  ]);
  const left = Math.min(rectangle[0], rectangle[2]);
  const top = Math.min(rectangle[1], rectangle[3]);
  const right = Math.max(rectangle[0], rectangle[2]);
  const bottom = Math.max(rectangle[1], rectangle[3]);
  if (
    !rectangle.every(Number.isFinite) ||
    right <= left || bottom <= top ||
    left < -tolerance || top < -tolerance ||
    right > viewport.width + tolerance || bottom > viewport.height + tolerance
  ) return null;

  return {
    left: `${100 * Math.max(0, left) / viewport.width}%`,
    top: `${100 * Math.max(0, top) / viewport.height}%`,
    width: `${100 * (Math.min(viewport.width, right) - Math.max(0, left)) / viewport.width}%`,
    height: `${100 * (Math.min(viewport.height, bottom) - Math.max(0, top)) / viewport.height}%`,
  };
}

export default function PdfEvidencePreview({ file, evidence, language }: {
  file: File;
  evidence: PdfEvidence;
  language: 'en' | 'hi';
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState<CSSProperties | null>(null);

  useEffect(() => {
    let disposed = false;
    let pdf: PDFDocumentProxy | null = null;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;
    const canvas = canvasRef.current;
    if (!canvas) return;
    setState('loading');
    setError('');
    setHighlight(null);

    async function render() {
      try {
        // File.arrayBuffer() never sends the document to an external service.
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (disposed) return;
        loadingTask = getDocument({
          data: bytes,
          isEvalSupported: false,
          disableAutoFetch: true,
          disableStream: true,
        });
        pdf = await loadingTask.promise;
        if (disposed) return;
        if (evidence.page < 1 || evidence.page > pdf.numPages) {
          throw new Error('Evidence page is outside the source PDF.');
        }
        const page = await pdf.getPage(evidence.page);
        if (disposed) return;
        const unscaled = page.getViewport({ scale: 1 });
        const pixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
        // The budget applies to the actual bitmap, including device pixel ratio.
        // Also cap either dimension for extremely narrow or tall PDF pages.
        const maxBitmapPixels = 9_000_000;
        const maxBitmapDimension = 4096;
        const area = unscaled.width * unscaled.height;
        if (!Number.isFinite(area) || area <= 0) {
          throw new Error('Invalid source PDF page dimensions.');
        }
        const scale = Math.min(
          1.5,
          Math.sqrt(maxBitmapPixels / (area * pixelRatio * pixelRatio)),
          maxBitmapDimension / (Math.max(unscaled.width, unscaled.height) * pixelRatio),
        );
        if (!Number.isFinite(scale) || scale <= 0) {
          throw new Error('Source PDF page is too large to preview.');
        }
        const viewport = page.getViewport({ scale });
        const marker = highlightForPage(page, viewport, evidence);
        const context = canvas?.getContext('2d');
        if (!canvas || !context) throw new Error('Canvas rendering is unavailable.');
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (!disposed) {
          setHighlight(marker);
          setState('ready');
        }
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
      // Cancel loading even if the document has not yet finished opening.
      if (loadingTask) void loadingTask.destroy();
      else if (pdf) void pdf.destroy();
    };
  }, [file, evidence]);

  return <div className="pdf-preview-body">
    {state === 'loading' && <p role="status">{language === 'hi' ? 'PDF पृष्ठ तैयार हो रहा है…' : 'Rendering PDF page…'}</p>}
    {state === 'error' && <p role="alert" className="error-banner">{error}</p>}
    <div className="pdf-stage" aria-label={language === 'hi' ? 'स्रोत PDF पृष्ठ' : 'Source PDF page'}>
      <div className="pdf-canvas-holder">
        <canvas ref={canvasRef} />
        {state === 'ready' && highlight &&
          <div className="evidence-highlight" style={highlight} aria-hidden="true" />}
      </div>
    </div>
    <p className="preview-help">{
      highlight
        ? language === 'hi'
          ? 'मूल स्रोत निर्देशांकों का हाइलाइट जाँच में सहायता करता है। पाठ और पृष्ठ स्वयं सत्यापित करें।'
          : 'Source highlight is positioned using the PDF page transform. Verify the original text and page.'
        : language === 'hi'
          ? 'पृष्ठ की ज्यामिति की पुष्टि नहीं हुई; संभावित गलत हाइलाइट के बजाय मूल पृष्ठ जाँचें।'
          : 'Page geometry could not be verified; inspect the source without an approximate highlight.'
    }</p>
  </div>;
}

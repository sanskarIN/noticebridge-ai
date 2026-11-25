import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { Evidence } from './comparison';

// Bundle PDF.js and its matching worker with the application. No external CDN
// receives the user's local document or its extracted evidence.
GlobalWorkerOptions.workerSrc = workerUrl;

type PdfEvidence = Pick<Evidence, 'bbox' | 'page_width' | 'page_height' | 'page_rotation'>;

const previewCopy = {
  rendering: 'Rendering PDF page…',
  page: 'Source PDF page',
  viewer: 'PDF page viewer',
  uncovered: 'No text was extracted from this page. Inspect the page directly.',
  uncheckedImage: 'Inspect the image on this page for notice text that may be missing from the comparison.',
  geometry: 'Page geometry could not be verified; inspect the source without an approximate highlight.',
  highlight: 'Source highlight is positioned using the PDF page transform. Verify the original text and page.',
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

export default function PdfEvidencePreview({ file, pageNumber, evidence, uncheckedImage, inspectionOnly }: {
  file: File;
  pageNumber: number;
  evidence?: PdfEvidence;
  uncheckedImage?: boolean;
  inspectionOnly?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const highlightRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [highlight, setHighlight] = useState<CSSProperties | null>(null);
  const t = previewCopy;

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
        if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) {
          throw new Error('Requested page is outside the source PDF.');
        }
        const page = await pdf.getPage(pageNumber);
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
        const marker = evidence ? highlightForPage(page, viewport, evidence) : null;
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
  }, [file, pageNumber, evidence]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    const marker = highlightRef.current;
    if (!highlight || !stage || !marker) return;
    const viewport = stage.getBoundingClientRect();
    const target = marker.getBoundingClientRect();
    if (target.top < viewport.top + 8 || target.bottom > viewport.bottom - 8) {
      stage.scrollTop += target.top - viewport.top - stage.clientHeight / 3;
    }
  }, [highlight]);

  return <div className="pdf-preview-body">
    {state === 'loading' && <p role="status">{t.rendering}</p>}
    {state === 'error' && <p role="alert" className="error-banner">{error}</p>}
    <div ref={stageRef} className="pdf-stage" role="region" aria-label={t.viewer} tabIndex={0}>
      <div className="pdf-canvas-holder">
        <canvas ref={canvasRef} role="img" aria-label={`${t.page} ${pageNumber}`} />
        {state === 'ready' && highlight &&
          <div ref={highlightRef} className="evidence-highlight" style={highlight} aria-hidden="true" />}
      </div>
    </div>
    {state === 'ready' && <p className="preview-help">
      {evidence ? (highlight ? t.highlight : t.geometry) : inspectionOnly ? 'Source page shown for manual inspection.' : uncheckedImage ? t.uncheckedImage : t.uncovered}
    </p>}
  </div>;
}

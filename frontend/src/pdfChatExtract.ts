import {getDocument,GlobalWorkerOptions} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {readNativePdf} from './pdfChatReadNative';
import type {Role} from './pdfChatCore';
export {MAX_PDF_BYTES} from './pdfChatReadNative';
GlobalWorkerOptions.workerSrc=workerUrl;
export function readPdf(file:File,role:Role,signal:AbortSignal){
  return readNativePdf(file,role,signal,getDocument);
}

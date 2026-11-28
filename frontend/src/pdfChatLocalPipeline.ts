/** Explicit loopback pipeline invocation; independent browser review remains mandatory. */
import { requestHash } from './pdfChatEmbeddingBridge';
import { localChatRequest } from './pdfChatLocalTransport';
import { MAX_PIPELINE_BYTES, reviewPipeline, type PipelineRequest, type PipelineReview } from './pdfChatPipeline';

export type LocalPipelineConfig = {
  embeddingModel: string;
  embeddingDigest: string;
  answerModel: string;
  answerDigest: string;
};
export function emptyLocalPipelineConfig(): LocalPipelineConfig {
  return { embeddingModel: '', embeddingDigest: '', answerModel: '', answerDigest: '' };
}
const MODEL = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,63})?:[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const SHA = /^[a-f0-9]{64}$/;
export function validLocalPipelineConfig(config: LocalPipelineConfig): boolean {
  return [config.embeddingModel, config.answerModel].every(name =>
    typeof name === 'string' && name.length <= 96 && MODEL.test(name) && !/cloud/i.test(name)) &&
    [config.embeddingDigest, config.answerDigest].every(digest =>
      typeof digest === 'string' && SHA.test(digest));
}

export async function requestLocalPipeline(
  request: PipelineRequest, config: LocalPipelineConfig, signal: AbortSignal,
  consent: boolean, transport = localChatRequest,
): Promise<PipelineReview> {
  if (consent !== true || !validLocalPipelineConfig(config) || !request.text ||
      new TextEncoder().encode(request.text).length > MAX_PIPELINE_BYTES) {
    throw new Error('Invalid local AI configuration or request.');
  }
  signal.throwIfAborted();
  // Snapshot configuration so asynchronous callers cannot change the binding.
  const { embeddingModel, embeddingDigest, answerModel, answerDigest } = config;
  const digest = await requestHash(request.text);
  signal.throwIfAborted();
  const form = new FormData();
  form.append('request_file', new Blob([request.text], { type: 'application/json' }), 'request.json');
  form.append('embedding_model', embeddingModel);
  form.append('embedding_digest', embeddingDigest);
  form.append('answer_model', answerModel);
  form.append('answer_digest', answerDigest);
  form.append('consent', 'true');
  const result = await transport('pipeline', form, signal);
  signal.throwIfAborted();
  const review = await reviewPipeline(result, request, digest);
  signal.throwIfAborted();
  if (review.ranking.model !== embeddingModel || review.ranking.digest !== embeddingDigest ||
      review.extractive.model !== answerModel || review.extractive.digest !== answerDigest) {
    throw new Error('Local model result does not match the selected model metadata.');
  }
  return review;
}

/** Explicit, read-only discovery of runtime-reported local tags and pins. */
import { isLocalChatOrigin, readBoundedJson } from './pdfChatLocalTransport';
import { validLocalPipelineConfig, type LocalPipelineConfig } from './pdfChatLocalPipeline';

export const MAX_LOCAL_MODELS = 1024;
export const MAX_MODEL_INVENTORY_BYTES = 256 * 1024;
const PATH = '/api/chat/models';
export type LocalModel = { name: string; digest: string };
export type LocalModelInventory = {
  format: 'noticebridge-local-model-inventory';
  version: 1;
  runtime_reported_only: true;
  authority_verified: false;
  reported_count: number;
  excluded_count: number;
  models: LocalModel[];
};
function invalid(): never { throw new Error('Invalid local model inventory.'); }
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length ||
      keys.some(key => !Object.prototype.hasOwnProperty.call(row, key))) invalid();
  return row;
}
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_LOCAL_MODELS) invalid();
  return value;
}
function validModel(model: LocalModel): boolean {
  return validLocalPipelineConfig({
    embeddingModel: model.name, embeddingDigest: model.digest,
    answerModel: model.name, answerDigest: model.digest,
  });
}
export function parseLocalModelInventory(text: string): LocalModelInventory {
  if (!text || text.length > MAX_MODEL_INVENTORY_BYTES ||
      new TextEncoder().encode(text).length > MAX_MODEL_INVENTORY_BYTES) invalid();
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalid(); }
  const row = exact(value, ['format', 'version', 'runtime_reported_only', 'authority_verified',
    'reported_count', 'excluded_count', 'models']);
  if (row.format !== 'noticebridge-local-model-inventory' || row.version !== 1 ||
      row.runtime_reported_only !== true || row.authority_verified !== false ||
      !Array.isArray(row.models) || row.models.length > MAX_LOCAL_MODELS) invalid();
  const reported_count = count(row.reported_count), excluded_count = count(row.excluded_count);
  if (reported_count !== excluded_count + row.models.length) invalid();
  const models = row.models.map(value => {
    const raw = exact(value, ['name', 'digest']);
    if (typeof raw.name !== 'string' || typeof raw.digest !== 'string') invalid();
    const model = { name: raw.name, digest: raw.digest };
    if (!validModel(model)) invalid();
    return model;
  });
  if (models.some((model, i) => i > 0 && models[i - 1].name >= model.name)) invalid();
  const result: LocalModelInventory = {
    format: 'noticebridge-local-model-inventory', version: 1,
    runtime_reported_only: true, authority_verified: false, reported_count, excluded_count, models,
  };
  // Python emits the same pretty JSON for the restricted ASCII fields.
  // Reject duplicate members, extra whitespace, and noncanonical order.
  if (text !== JSON.stringify(result, null, 2) + '\n') invalid();
  return result;
}
export async function requestLocalModelInventory(signal: AbortSignal, consent: boolean,
  origin = globalThis.location?.origin, fetcher: typeof fetch = fetch): Promise<LocalModelInventory> {
  if (consent !== true || !isLocalChatOrigin(origin ?? '')) {
    throw new Error('Model inventory requires an explicitly approved loopback request.');
  }
  signal.throwIfAborted();
  const response = await fetcher(PATH, {
    method: 'GET', signal, credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { 'X-NoticeBridge-Local-AI': '1' },
  });
  if (response.redirected || (response.url && response.url !== origin + PATH)) invalid();
  const text = await readBoundedJson(response, MAX_MODEL_INVENTORY_BYTES);
  signal.throwIfAborted();
  return parseLocalModelInventory(text);
}
export function inventoryChoice(inventory: LocalModelInventory, config: LocalPipelineConfig,
  purpose: 'embedding' | 'answer', tag: string): LocalPipelineConfig {
  const model = inventory.models.find(model => model.name === tag);
  if (!model || !validModel(model) || (purpose !== 'embedding' && purpose !== 'answer')) invalid();
  return purpose === 'embedding' ? { ...config, embeddingModel: model.name, embeddingDigest: model.digest }
    : { ...config, answerModel: model.name, answerDigest: model.digest };
}
export function selectedInventoryTag(inventory: LocalModelInventory, config: LocalPipelineConfig,
  purpose: 'embedding' | 'answer'): string {
  const name = purpose === 'embedding' ? config.embeddingModel : config.answerModel;
  const digest = purpose === 'embedding' ? config.embeddingDigest : config.answerDigest;
  return inventory.models.some(model => model.name === name && model.digest === digest) ? name : '';
}

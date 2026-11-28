/** Load only the artifacts named by a validated local manifest. */
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseDataset, MAX_MANIFEST_BYTES, MAX_DATASET_TOTAL_BYTES, type DatasetArtifact } from './retrievalDataset';
import { MAX_CORPUS_SNAPSHOT_BYTES } from '../src/pdfChatCorpusSnapshot';
import { localFile, readBounded } from './localFiles';

export function readDatasetInput(path: string): { manifest: string; artifacts: DatasetArtifact[] } {
  const manifest = readBounded(path, MAX_MANIFEST_BYTES);
  const dataset = parseDataset(manifest.text);
  const root = realpathSync(dirname(path));
  let bytes = 0;
  const artifacts = dataset.documents.map(document => {
    const file = readBounded(
      localFile(root, document.snapshot),
      Math.min(MAX_CORPUS_SNAPSHOT_BYTES, MAX_DATASET_TOTAL_BYTES - bytes),
    );
    bytes += file.bytes;
    return { name: document.snapshot, text: file.text, sha256: file.sha256 };
  });
  return { manifest: manifest.text, artifacts };
}

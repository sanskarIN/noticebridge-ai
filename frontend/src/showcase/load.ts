import type { DocumentRole } from '../comparison';
import fixture from './generated';

function loadSource(role: DocumentRole): File {
  const source = fixture.sources.find(item => item.role === role);
  if (!source) throw new Error('The fictional notice could not be loaded.');
  const bytes = Uint8Array.from(atob(source.base64), character => character.charCodeAt(0));
  return new File([bytes], source.name, { type: 'application/pdf' });
}

export function loadShowcase() {
  return {
    original: loadSource('original'),
    revised: loadSource('revised'),
    report: fixture.report,
  };
}

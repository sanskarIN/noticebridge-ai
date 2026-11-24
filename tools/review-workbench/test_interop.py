"""Cross-language fixture export check; optional exact repository CLI checks.

The labels are fictional test fixtures, never independent human evidence.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unicodedata

import pymupdf

ROOT = Path(__file__).resolve().parent
JS = r'''const fs = require('node:fs'), path = require('node:path');
const {webcrypto} = require('node:crypto'), C = require(process.argv[1]);
(async () => {
  const dir = process.argv[2], manifest = fs.readFileSync(path.join(dir, 'source.json'), 'utf8');
  const cases = C.blank(manifest), c = cases[0];
  for (const role of ['original', 'revised']) {
    await C.verifyPdf(new Blob([fs.readFileSync(path.join(dir, c.source[role]))]),
                      c.source[role + '_sha256'], webcrypto);
    c.verified[role] = true;
  }
  c.pairs = [{original_page:1,original_text:'Application deadline: 13 December 2026',
              revised_page:1,revised_text:'Application deadline: 19 December 2026'}];
  C.complete(c, true);
  process.stdout.write(C.exportReview(cases,{final:true}));
})().catch(error => {console.error(error);process.exitCode=1;});'''


def normalize(text):
    return ' '.join(unicodedata.normalize('NFKC', text).casefold().split())


def run(repo=None):
    with tempfile.TemporaryDirectory(prefix='noticebridge-interop-') as tmp:
        folder = Path(tmp)
        for file in (ROOT / 'example').iterdir():
            shutil.copyfile(file, folder / file.name)
        raw = subprocess.check_output(['node', '-e', JS, str(ROOT / 'core.js'), str(folder)])
        review = json.loads(raw.decode('utf-8'))
        source = json.loads((folder / 'source.json').read_text(encoding='utf-8'))
        assert review['version'] == 2 and len(review['cases']) == 1
        case, base = review['cases'][0], source['cases'][0]
        assert case['review_complete'] is True and case['label_method'] == 'independent_human'
        for key in ('id', 'source_kind', 'issuer_group', 'event_group', 'original', 'revised',
                    'original_sha256', 'revised_sha256'):
            assert case[key] == base[key], key
        assert len(case['expected_pairs']) == 1
        pair = case['expected_pairs'][0]
        for role in ('original', 'revised'):
            content = (folder / case[role]).read_bytes()
            assert hashlib.sha256(content).hexdigest() == case[role + '_sha256']
            with pymupdf.open(stream=content, filetype='pdf') as pdf:
                page = pair[role + '_page']
                assert type(page) is int and 1 <= page <= pdf.page_count
                assert normalize(pair[role + '_text']) in {
                    normalize(line) for line in pdf[page - 1].get_text().splitlines()
                }
        # Test canonical UTF-8 encoding used by the Python manifest digest.
        json.dumps(review, ensure_ascii=False, sort_keys=True, allow_nan=False).encode('utf-8')
        review_path = folder / 'review.json'
        review_path.write_bytes(raw)
        print('PASS: actual fictional PDF bytes, SHA-256, source metadata, UTF-8 JSON, page and quote round trip')
        if repo:
            backend = repo.resolve() / 'backend'
            env = os.environ.copy()
            env['PYTHONPATH'] = str(backend)
            commands = [
                [str(backend / 'benchmarks/prepare_independent_review.py'), str(folder / 'source.json'),
                 '--check', str(review_path)],
                [str(backend / 'benchmarks/audit_review_quotes.py'), str(review_path),
                 '--require-native-exact'],
            ]
            for command in commands:
                result = subprocess.run([sys.executable, *command], cwd=repo, env=env,
                                        capture_output=True, text=True, check=True, timeout=45)
                print(json.dumps(json.loads(result.stdout), indent=2))
            print('PASS: actual repository review checker and native quote audit CLI')
        else:
            print('Repository CLI checks not run; use --repo with a checkout containing PR #19.')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, help='Local NoticeBridge checkout containing PR #19')
    run(parser.parse_args().repo)

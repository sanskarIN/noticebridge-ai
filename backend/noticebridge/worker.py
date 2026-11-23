"""JSON-lines-free, one-request-only subprocess entry point.

The worker accepts untrusted PDF bytes as base64 over stdin. Only validated
structured evidence or a sanitized InvalidDocument message goes to stdout.
"""

import base64
import binascii
import json
import sys

from .compare import compare_documents
from .extract import MAX_UPLOAD_BYTES, InvalidDocument, extract_pdf

MAX_B64_CHARS = 4 * ((MAX_UPLOAD_BYTES + 2) // 3)
MAX_REQUEST_BYTES = (2 * MAX_B64_CHARS) + 8192
MAX_RESULT_BYTES = 64 * 1024 * 1024


def _decode_pdf(request: object) -> tuple[bytes, str]:
    if not isinstance(request, dict):
        raise InvalidDocument("Malformed comparison request")
    encoded = request.get("base64")
    filename = request.get("filename")
    if (
        not isinstance(encoded, str)
        or not isinstance(filename, str)
        or not filename
        or len(filename) > 200
        or len(encoded) > MAX_B64_CHARS
    ):
        raise InvalidDocument("Malformed comparison request")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise InvalidDocument("Invalid document encoding") from exc
    if not content or len(content) > MAX_UPLOAD_BYTES:
        raise InvalidDocument("Each PDF must be nonempty and at most 10 MiB")
    return content, filename


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise InvalidDocument("Comparison request exceeds the size limit")
        request = json.loads(raw)
        if not isinstance(request, dict) or not isinstance(request.get("enable_ocr"), bool):
            raise InvalidDocument("Malformed comparison request")
        original, old_name = _decode_pdf(request.get("original"))
        revised, new_name = _decode_pdf(request.get("revised"))
        old_document = extract_pdf(
            original, document_id="original", filename=old_name,
            enable_ocr=request["enable_ocr"],
        )
        new_document = extract_pdf(
            revised, document_id="revised", filename=new_name,
            enable_ocr=request["enable_ocr"],
        )
        response = compare_documents(old_document, new_document).model_dump_json().encode("utf-8")
        if len(response) > MAX_RESULT_BYTES:
            raise InvalidDocument("Comparison result exceeds the safety limit")
    except (json.JSONDecodeError, UnicodeDecodeError):
        response = json.dumps(
            {"error": "invalid_document", "message": "Malformed comparison request"}
        ).encode("utf-8")
    except InvalidDocument as exc:
        response = json.dumps(
            {"error": "invalid_document", "message": str(exc)}
        ).encode("utf-8")
    sys.stdout.buffer.write(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

{% raw %}
<!-- One namespace of the CAR WebSocket Protocol Reference (../websocket-protocol.md). Each `### ` section below is listed, in order, by an include line in that file; scripts/lib/ws_protocol.py reassembles the whole reference for every tool that reads it. A new `### ` section needs a matching include line there, or every check fails. -->
[← CAR WebSocket Protocol Reference](../websocket-protocol.md)

### vision

#### `vision.ocr`
- **Params**: `{ image_path: string, fast_path?: boolean, languages?: string[], language_correction?: boolean, minimum_text_height?: number }`
- **Returns**: `{ available: boolean, observations: [ { text, confidence, x, y, w, h }, ... ] }`
- On-device text recognition. On macOS this uses Apple Vision's `VNRecognizeTextRequest`; on other hosts (or macOS builds without the Swift shim) it falls back to the **Tesseract CLI** if `tesseract` is installed on `PATH` (car#360) — same params, same result shape. `fast_path: true` selects `.fast` over `.accurate` recognition (~5× faster, lower accuracy; Apple path only). `languages` are BCP-47 hints (e.g. `["en-US"]`); empty lets the backend auto-detect (the Tesseract backend maps common BCP-47 tags to Tesseract language codes and passes through codes like `"eng"`). Bounding boxes are normalized to `[0, 1]` in a bottom-left origin coordinate space (the Tesseract backend flips Tesseract's top-left pixel coordinates to match). `available` is `false` only when neither backend is reachable — no Apple shim **and** no `tesseract` on `PATH`; in that case `observations` is an empty array rather than an error so callers can distinguish "OCR unavailable here" from "OCR ran and found no text."


{% endraw %}

const DEFAULT_HEADERS = {
  Referer: "https://data.eastmoney.com/report/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  Accept: "application/pdf,*/*",
};

export function eastmoneyReportPdfHeaders(overrides = {}) {
  return { ...DEFAULT_HEADERS, ...overrides };
}

export function isPdfBytes(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
}

export async function downloadPdfBytes(url, { fetchImpl = fetch, headers } = {}) {
  const response = await fetchImpl(url, { headers: eastmoneyReportPdfHeaders(headers) });
  const contentType = response.headers.get("content-type") || "";
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`remote pdf download failed: status=${response.status} contentType=${contentType || "unknown"} body=${responseDiagnostic(bytes)} url=${url}`);
  }
  if (!isPdfBytes(bytes)) {
    throw new Error(`remote pdf download returned non-PDF: status=${response.status} contentType=${contentType || "unknown"} body=${responseDiagnostic(bytes)} url=${url}`);
  }
  if (bytes.length < 1000) {
    throw new Error(`remote pdf download is too small: bytes=${bytes.length} contentType=${contentType || "unknown"} url=${url}`);
  }
  return bytes;
}

function responseDiagnostic(bytes) {
  return textDiagnostic(bytes.subarray(0, 240).toString("utf8"));
}

function textDiagnostic(value) {
  return JSON.stringify(String(value).replace(/\s+/g, " ").trim().slice(0, 200));
}

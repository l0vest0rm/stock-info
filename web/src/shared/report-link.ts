export function knowledgeReportLink(docId: string, filtered = false): string {
  return `/api/knowledge/file?id=${encodeURIComponent(docId)}${filtered ? '&filtered=1' : ''}`;
}

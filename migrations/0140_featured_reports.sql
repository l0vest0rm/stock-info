-- Approved as part of the featured-report implementation plan (2026-09-14).
CREATE TABLE featured_reports (
  code TEXT PRIMARY KEY CHECK (length(code) = 6 AND code GLOB '[1-9][0-9][0-9][0-9][0-9][0-9]'),
  report_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  institution TEXT NOT NULL DEFAULT '',
  report_date TEXT NOT NULL DEFAULT '',
  pdf_key TEXT NOT NULL,
  content_key TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'withdrawn')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

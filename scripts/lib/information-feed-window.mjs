export const MAX_FEED_AGE_HOURS = 48;

export function isRecentFeedTime(value, now = Date.now(), maxAgeHours = MAX_FEED_AGE_HOURS) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && time <= now && time >= now - maxAgeHours * 60 * 60 * 1000;
}

export function recentFeedRows(rows, now = Date.now(), maxAgeHours = MAX_FEED_AGE_HOURS) {
  return rows.filter((row) => isRecentFeedTime(row.sort_time, now, maxAgeHours))
    .sort((a, b) => b.sort_time.localeCompare(a.sort_time) || b.doc_id.localeCompare(a.doc_id));
}

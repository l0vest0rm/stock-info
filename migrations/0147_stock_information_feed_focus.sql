-- Only explicitly selected securities qualify for the company branch of the
-- information-feed relevance gate. Industry and macro rules are independent.
alter table stock add column information_feed_focus integer not null default 0
  check (information_feed_focus in (0, 1));

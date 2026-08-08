-- A selected effort belongs to the durable job: the local runner may claim it
-- after a page reload, so it cannot live only in browser state.
alter table research_operating_analysis_jobs add column reasoning_effort text not null default 'high'
  check (reasoning_effort in ('none', 'low', 'medium', 'high', 'xhigh', 'max'));

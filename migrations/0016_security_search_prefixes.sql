create table if not exists security_search_prefixes (
  prefix text not null,
  code text not null,
  priority integer not null default 0,
  primary key (prefix, code),
  foreign key (code) references securities(code) on delete cascade
);

create index if not exists idx_security_search_prefixes_code
  on security_search_prefixes(code);

delete from security_search_prefixes;

with recursive nums(n) as (
  select 1
  union all
  select n + 1 from nums where n < 24
),
security_terms as (
  select code, lower(trim(code)) as term, 0 as priority
    from securities
  union
  select code,
         lower(trim(case
           when instr(code, '.') > 0 then substr(code, 1, instr(code, '.') - 1)
           else code
         end)) as term,
         0 as priority
    from securities
  union
  select code, lower(trim(name)) as term, 1 as priority
    from securities
  union
  select code, lower(replace(trim(name), ' ', '')) as term, 2 as priority
    from securities
)
insert into security_search_prefixes (prefix, code, priority)
select distinct substr(term, 1, nums.n) as prefix, code, priority
  from security_terms
  join nums on nums.n <= length(term)
 where term != ''
on conflict(prefix, code) do update set
  priority = min(security_search_prefixes.priority, excluded.priority);

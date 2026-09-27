-- One canonical short name per security; aliases remain many-to-many so an
-- ambiguous name can produce candidates instead of silently changing owner.
create table knowledge_stocks (
  code text primary key,
  short_name text not null check (trim(short_name) <> ''),
  updated_at integer not null
);

insert into knowledge_stocks (code, short_name, updated_at)
select distinct old.code,
  coalesce((
    select trim(candidate.name)
    from knowledge_stock_aliases candidate
    where candidate.code = old.code and trim(coalesce(candidate.name, '')) <> ''
    order by case when candidate.source = 'target' then 0 else 1 end,
      candidate.updated_at desc, candidate.alias
    limit 1
  ), old.code),
  max(old.updated_at)
from knowledge_stock_aliases old
group by old.code;

alter table knowledge_stock_aliases rename to knowledge_stock_aliases_old;
create table knowledge_stock_aliases (
  alias text not null check (alias = lower(trim(alias)) and alias <> ''),
  code text not null,
  source text,
  updated_at integer not null,
  primary key (alias, code),
  foreign key (code) references knowledge_stocks(code) on delete restrict
);

insert into knowledge_stock_aliases (alias, code, source, updated_at)
select lower(trim(old.alias)), old.code,
  (select candidate.source from knowledge_stock_aliases_old candidate
   where candidate.code = old.code and lower(trim(candidate.alias)) = lower(trim(old.alias))
   order by candidate.updated_at desc, candidate.alias limit 1),
  max(old.updated_at)
from knowledge_stock_aliases_old old
where trim(old.alias) <> ''
group by lower(trim(old.alias)), old.code;

drop table knowledge_stock_aliases_old;
create index idx_knowledge_stock_aliases_code on knowledge_stock_aliases(code);

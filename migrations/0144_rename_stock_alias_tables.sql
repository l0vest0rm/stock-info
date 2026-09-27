-- Use the shared stock identity names outside the knowledge-import namespace.
alter table knowledge_stocks rename to stock;
alter table knowledge_stock_aliases rename to stock_alias;
drop index idx_knowledge_stock_aliases_code;
create index idx_stock_alias_code on stock_alias(code);

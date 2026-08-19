-- These were a partial, non-authoritative discovery cache and its derived
-- prefix index. Runtime lookups now use the upstream suggestion endpoint.
drop table if exists security_search_prefixes;
drop table if exists securities;

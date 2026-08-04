-- The numeric share count must retain its explicit multiplier so price × shares
-- cannot silently mix individual shares with millions of shares.
alter table research_reverse_valuation_model_versions add column diluted_shares_scale text not null default 'unspecified';

-- Stock codes are canonical identities, not names. Their qualified and bare
-- spellings are derived by readers rather than stored as stock_alias rows.
delete from stock_alias
where alias = lower(code)
   or alias = lower(case
      when code like '%.T' then substr(code, 1, length(code) - 2)
      when code like '%.%' then substr(code, 1, length(code) - 3)
      else code
    end)
   or (instr(code, '.') > 0 and alias = lower(substr(code, 1, instr(code, '.') - 1)))
   or source = 'stock_identity_backfill';

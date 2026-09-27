/** Insert canonical short names before alias rows to satisfy the code FK. */
export function stockAliasStatements(aliases, updatedAt, quote) {
  const stockNames = new Map();
  for (const alias of aliases) {
    if (alias.name && !stockNames.has(alias.code)) stockNames.set(alias.code, alias.name);
  }
  return [
    ...[...stockNames.entries()].map(([code, name]) =>
      `insert into stock (code, short_name, updated_at)
         values (${quote(code)}, ${quote(name)}, ${updatedAt})
         on conflict(code) do update set
           short_name=excluded.short_name,
           updated_at=excluded.updated_at
         where excluded.updated_at >= stock.updated_at;`
    ),
    ...aliases.filter((alias) => stockNames.has(alias.code)).map((alias) =>
      `insert into stock_alias (alias, code, source, updated_at)
         values (lower(trim(${quote(alias.alias)})), ${quote(alias.code)}, ${quote(alias.source)}, ${updatedAt})
         on conflict(alias, code) do update set
           source=excluded.source,
           updated_at=excluded.updated_at
         where excluded.updated_at >= stock_alias.updated_at;`
    ),
  ];
}

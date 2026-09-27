# Stock name and alias mapping

`stock` stores one current short name per canonical security code
(for example, `300750.SZ`). `stock_alias` stores additional name-to-code
mappings for news and document recognition. Its key is `(alias, code)`, so a
stock can have multiple names and an ambiguous name can refer to multiple stocks.

Aliases are stored trimmed and lowercase. Writers and lookup queries must apply
the same normalization. Full codes and bare tickers are **not** aliases; they
are derived from `stock.code` when needed. News matching also reads
`stock.short_name` directly, so an alias row is not required for the current
canonical name. Lookups join the alias table to `stock` to obtain the current
short name. The `source` field records where a name mapping was discovered; it
is not a uniqueness key or proof that a candidate is safe to attribute without
context.

Legacy codes with no recorded name use the code as a display placeholder.
This is not evidence of an official short name and should be replaced when a
verified name is available.

The knowledge-document importer adds stock names before their aliases and does
not persist code-derived aliases. Aliases without a known short name are not
imported. Feed extraction reads canonical names plus name aliases and recognizes
explicit market-suffixed codes in application logic; bare numeric codes are not
matched in free text because they can also be prices or dates. A name shared by
multiple codes is not silently resolved to a single security. The local
company-code resolver likewise derives exact full/bare-code lookups from
`stock.code` and leaves conflicting names or bare codes unresolved.

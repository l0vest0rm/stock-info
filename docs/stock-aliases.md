# Stock name and alias mapping

`stock` stores one current short name per canonical security code
(for example, `300750.SZ`). `stock_alias` stores one row per
normalized alias and candidate code. Its key is `(alias, code)`, so a stock can
have multiple names and an ambiguous name can refer to multiple stocks.

Aliases are stored trimmed and lowercase. Writers and lookup queries must apply
the same normalization; `300750.SZ` and `300750.sz` are one alias. The code
itself remains in the canonical market-suffixed format. Lookups join the alias
table to `stock` to obtain the current short name, rather than
duplicating it on each alias row. The `source` field records where the mapping
was discovered; it is not a uniqueness key or proof that a candidate is safe
to attribute without context.

Legacy codes with no recorded name use the code as a display placeholder.
This is not evidence of an official short name and should be replaced when a
verified name is available.

The knowledge-document importer adds stock names before their aliases. Aliases
without a known short name are not imported. Feed extraction reads the joined
alias/stock index and receives candidates; a name shared by multiple codes is
not silently resolved to a single security. The local company-code resolver
similarly leaves conflicting aliases unresolved.

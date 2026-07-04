alter table knowledge_filtered_docs add column access_method text;

update knowledge_filtered_docs
set access_method = case
  when exists (
    select 1
    from knowledge_filtered_doc_content_refs c
    where c.doc_id = knowledge_filtered_docs.doc_id
      and coalesce(c.content_key, '') != ''
  ) then 'markdown'
  when lower(coalesce(url, '')) like '%.pdf'
    or lower(coalesce(url, '')) like '%.pdf?%'
    or lower(coalesce(url, '')) like '%.pdf#%'
  then 'remote_pdf'
  else ''
end
where coalesce(access_method, '') = '';

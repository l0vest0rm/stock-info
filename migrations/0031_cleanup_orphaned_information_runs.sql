-- A running run without a processing job was interrupted before it could finish.
-- It is not valid information-processing history.
delete from knowledge_preprocessing_decisions
 where version_id in (
   select run.version_id
     from knowledge_processing_runs run
     join knowledge_document_versions version on version.version_id = run.version_id
    where not exists (
      select 1 from information_processing_jobs job
       where job.doc_id = version.doc_id and job.status = 'processing'
    )
    group by run.version_id
   having sum(case when run.status <> 'running' then 1 else 0 end) = 0
 );
delete from knowledge_information_records
 where result_id in (
   select result.result_id
     from knowledge_document_results result
     join knowledge_processing_runs run on run.run_id = result.run_id
     join knowledge_document_versions version on version.version_id = run.version_id
    where run.status = 'running'
      and not exists (
        select 1 from information_processing_jobs job
         where job.doc_id = version.doc_id and job.status = 'processing'
      )
 );
delete from knowledge_document_results
 where run_id in (
   select run.run_id
     from knowledge_processing_runs run
     join knowledge_document_versions version on version.version_id = run.version_id
    where run.status = 'running'
      and not exists (
        select 1 from information_processing_jobs job
         where job.doc_id = version.doc_id and job.status = 'processing'
      )
 );
delete from knowledge_processing_runs
 where run_id in (
   select run.run_id
     from knowledge_processing_runs run
     join knowledge_document_versions version on version.version_id = run.version_id
    where run.status = 'running'
      and not exists (
        select 1 from information_processing_jobs job
         where job.doc_id = version.doc_id and job.status = 'processing'
      )
 );
delete from knowledge_document_versions
 where not exists (select 1 from knowledge_processing_runs run where run.version_id = knowledge_document_versions.version_id)
   and not exists (select 1 from knowledge_preprocessing_decisions decision where decision.version_id = knowledge_document_versions.version_id);

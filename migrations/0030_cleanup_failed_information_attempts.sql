-- A failed local LLM attempt is retryable work, not retained information history.
delete from knowledge_information_records
 where result_id in (
   select result_id from knowledge_document_results
    where run_id in (select run_id from knowledge_processing_runs where status = 'failed')
 );
delete from knowledge_document_results
 where run_id in (select run_id from knowledge_processing_runs where status = 'failed');

-- Remove preprocessing metadata only for versions whose every run failed.
delete from knowledge_preprocessing_decisions
 where version_id in (
   select distinct failed.version_id
     from knowledge_processing_runs failed
    where failed.status = 'failed'
      and not exists (
        select 1 from knowledge_processing_runs remaining
         where remaining.version_id = failed.version_id and remaining.status <> 'failed'
      )
 );
delete from knowledge_processing_runs where status = 'failed';

-- Versions without a run or preprocessing decision can only be abandoned attempts.
delete from knowledge_document_versions
 where not exists (select 1 from knowledge_processing_runs run where run.version_id = knowledge_document_versions.version_id)
   and not exists (select 1 from knowledge_preprocessing_decisions decision where decision.version_id = knowledge_document_versions.version_id);

delete from information_processing_jobs where status = 'failed';

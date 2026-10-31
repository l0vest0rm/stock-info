-- Compact acquisition control plane; preserve host user_version ordering.
-- Fail closed instead of dropping unrelated host tasks.
SELECT CASE WHEN EXISTS(SELECT 1 FROM tasks WHERE task_type!='acquisition')
 THEN json('unexpected non-acquisition tasks: refusing migration') ELSE 1 END;
-- All legacy results are moved to the host business store before removal.
ALTER TABLE acquisition_sessions ADD COLUMN state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state_json));
-- Host-owned migration ordering. No user_version or result tables here.
CREATE TABLE IF NOT EXISTS acquisition_tasks (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, flow_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused','disabled')),
 config_json TEXT NOT NULL CHECK(json_valid(config_json)),
 targets_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(targets_json)),
 state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state_json)),
 last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS acquisition_runs (
 id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES acquisition_tasks(id),
 status TEXT NOT NULL, started_at TEXT, finished_at TEXT, error_message TEXT,
 metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS acquisition_runs_task ON acquisition_runs(task_id,id);
CREATE TABLE IF NOT EXISTS acquisition_sessions (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, site TEXT NOT NULL,
 runtime_type TEXT NOT NULL, credential_json TEXT NOT NULL CHECK(json_valid(credential_json)),
 state_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(state_json)),
 expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

INSERT INTO acquisition_tasks(id,name,flow_id,status,config_json,targets_json,state_json,last_run_at,created_at,updated_at)
SELECT t.id,t.name,COALESCE(t.flow_id,t.name),t.status,COALESCE(t.settings_json,'{"interval":"5m"}'),
 COALESCE((SELECT json_group_array(json_object('id',t.id*1000000+a.id,'scope_id',a.id,'identity_key',a.identity_key,'input',json(a.input_json),'revision',a.revision,'enabled',json(CASE WHEN tt.enabled=1 THEN 'true' ELSE 'false' END),'resolution_error',a.resolution_error,
 'members',json(COALESCE((SELECT json_group_array(json_object('id',m.child_target_id,'input',json(child.input_json),'active',json(CASE WHEN m.active=1 THEN 'true' ELSE 'false' END),'last_seen_at',m.last_seen_at)) FROM acquisition_target_memberships m JOIN acquisition_targets child ON child.id=m.child_target_id WHERE m.parent_target_id=a.id),'[]'))))
 FROM acquisition_task_targets tt JOIN acquisition_targets a ON a.id=tt.target_id WHERE tt.task_id=t.id),'[]'),
 json_object('watermarks',json(COALESCE((SELECT json_group_object(scope,watermark) FROM acquisition_poll_watermarks WHERE task_id=t.id),'{}'))),
 t.last_run_at,t.created_at,t.updated_at FROM tasks t WHERE t.task_type='acquisition';
INSERT INTO acquisition_runs(id,task_id,status,started_at,finished_at,error_message,metadata_json,created_at)
 SELECT r.id,r.task_id,r.status,r.started_at,r.finished_at,r.error_message,COALESCE(r.metadata_json,'{}'),r.created_at FROM task_runs r JOIN acquisition_tasks t ON t.id=r.task_id;
UPDATE acquisition_sessions SET state_json=COALESCE((SELECT json_group_object(cache_key,json(s.state_json)) FROM acquisition_session_state s WHERE s.session_name=acquisition_sessions.name),'{}');
INSERT INTO acquisition_sessions(name,site,runtime_type,credential_json,state_json,created_at,updated_at)
 SELECT session_name,'','http','{}',json_group_object(cache_key,json(state_json)),datetime('now'),datetime('now') FROM acquisition_session_state
 WHERE session_name NOT IN (SELECT name FROM acquisition_sessions) GROUP BY session_name;
-- Inline canonical content reuses the host's existing local reader. Preserve raw
-- payload + original tags in metadata; never enqueue publication/model work.
INSERT INTO knowledge_docs(doc_id,source_type,report_type,source_name,title,url,published_at,fetched_at,access_method,summary,content_preview,inline_content,metadata_json,sort_time,source_name_normalized,updated_at)
SELECT 'acq_'||r.task_id||'_'||r.record_hash,'information_feed','news',COALESCE(json_extract(r.content_json,'$.source_name'),r.source),COALESCE(json_extract(r.content_json,'$.title'),''),COALESCE(json_extract(r.content_json,'$.source_url'),''),
 json_extract(r.content_json,'$.published_at'),r.created_at,'inline',COALESCE(json_extract(r.content_json,'$.summary'),''),substr(COALESCE(json_extract(r.content_json,'$.body'),''),1,280),COALESCE(json_extract(r.content_json,'$.body'),''),
 json_object('acquisition',json_object('taskId',r.task_id,'taskName',t.name,'dedupKey',r.record_hash,'source',r.source,'raw',json(r.data_json),'content',json(COALESCE(r.content_json,'{}')),'tags',json(COALESCE((SELECT json_group_array(json_object('key',key,'value',value)) FROM acquisition_record_tags WHERE record_id=r.id),'[]')))),
 COALESCE(json_extract(r.content_json,'$.published_at'),r.created_at),lower(COALESCE(json_extract(r.content_json,'$.source_name'),r.source)),CAST(strftime('%s','now') AS INTEGER)*1000
FROM acquisition_records r JOIN acquisition_tasks t ON t.id=r.task_id WHERE true
ON CONFLICT(doc_id) DO NOTHING;
DROP TABLE acquisition_record_tags;
DROP TABLE acquisition_records;
DROP TABLE acquisition_poll_watermarks;
DROP TABLE acquisition_task_targets;
DROP TABLE acquisition_target_memberships;
DROP TABLE acquisition_targets;
DROP TABLE acquisition_session_state;
DROP TABLE acquisition_control_imports;
DROP TABLE task_runs;
DROP TABLE tasks;

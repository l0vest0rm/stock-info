-- Acquisition-owned tables only. Host owns migration ordering/user_version.

            CREATE TABLE IF NOT EXISTS tasks (
              id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, config_path TEXT NOT NULL,
              runtime_type TEXT NOT NULL, session_id INTEGER, status TEXT NOT NULL DEFAULT 'active',
              last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
              task_type TEXT NOT NULL DEFAULT 'acquisition', flow_id TEXT, settings_json TEXT CHECK(settings_json IS NULL OR json_valid(settings_json))
            );
            CREATE TABLE IF NOT EXISTS task_runs (
              id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
              status TEXT NOT NULL, started_at TEXT, finished_at TEXT, error_message TEXT,
              metadata_json TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS acquisition_records (
              id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
              run_id INTEGER REFERENCES task_runs(id), source TEXT NOT NULL,
              data_json TEXT NOT NULL CHECK(json_valid(data_json)), record_hash TEXT NOT NULL,
              created_at TEXT NOT NULL, content_json TEXT CHECK(content_json IS NULL OR json_valid(content_json)),
              UNIQUE(task_id, record_hash)
            );
            CREATE TABLE IF NOT EXISTS acquisition_record_tags (
              record_id INTEGER NOT NULL REFERENCES acquisition_records(id) ON DELETE CASCADE,
              key TEXT NOT NULL, value TEXT NOT NULL,
              PRIMARY KEY(record_id,key,value)
            );
            CREATE INDEX IF NOT EXISTS record_tags_filter ON acquisition_record_tags(key,value,record_id);
            CREATE TABLE IF NOT EXISTS acquisition_poll_watermarks (
              task_id INTEGER NOT NULL REFERENCES tasks(id), scope TEXT NOT NULL,
              watermark INTEGER NOT NULL, PRIMARY KEY(task_id,scope)
            );
            CREATE TABLE IF NOT EXISTS acquisition_sessions (
              id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, site TEXT NOT NULL,
              runtime_type TEXT NOT NULL, credential_json TEXT NOT NULL CHECK(json_valid(credential_json)),
              expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS records_created ON acquisition_records(created_at);
CREATE TABLE IF NOT EXISTS acquisition_targets (
        id INTEGER PRIMARY KEY, site TEXT NOT NULL, kind TEXT NOT NULL, identity_key TEXT NOT NULL,
        input_json TEXT NOT NULL CHECK(json_valid(input_json)), revision INTEGER NOT NULL DEFAULT 1, resolution_error TEXT,
        UNIQUE(site,kind,identity_key));
        CREATE TABLE IF NOT EXISTS acquisition_task_targets (
        task_id INTEGER NOT NULL REFERENCES tasks(id), target_id INTEGER NOT NULL REFERENCES acquisition_targets(id),
        enabled INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(task_id,target_id));
        CREATE TABLE IF NOT EXISTS acquisition_session_state (
        session_name TEXT NOT NULL, cache_key TEXT NOT NULL, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
        PRIMARY KEY(session_name,cache_key));
        CREATE TABLE IF NOT EXISTS acquisition_control_imports (name TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS acquisition_target_memberships (parent_target_id INTEGER NOT NULL REFERENCES acquisition_targets(id),child_target_id INTEGER NOT NULL REFERENCES acquisition_targets(id),active INTEGER NOT NULL DEFAULT 1,last_seen_at TEXT NOT NULL,PRIMARY KEY(parent_target_id,child_target_id));

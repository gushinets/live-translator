ALTER TABLE live_sessions ADD COLUMN client_build_id TEXT CHECK(client_build_id IS NULL OR length(client_build_id) BETWEEN 1 AND 64);
ALTER TABLE live_sessions ADD COLUMN interpreter_prompt_id TEXT CHECK(interpreter_prompt_id IS NULL OR length(interpreter_prompt_id)=71);

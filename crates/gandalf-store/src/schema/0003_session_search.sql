-- Turn-level session index. Every stored activity event that carries text a
-- person would search for (what the user typed, what the agent said, commands,
-- edits, failures) gets one row, built from the event's redacted excerpt.
-- Triggers keep the index in step with activity_events, so ingestion code
-- does not write it directly.

CREATE VIEW session_turn_source AS
SELECT
    event_seq,
    project_id,
    session_id,
    provider,
    occurred_at,
    role,
    body
FROM (
    SELECT
        e.event_seq,
        e.project_id,
        e.session_id,
        json_extract(e.source_json, '$.provider') AS provider,
        e.occurred_at,
        CASE json_extract(e.payload_json, '$.kind')
            WHEN 'message.created' THEN
                CASE e.actor WHEN 'human' THEN 'user' WHEN 'agent' THEN 'agent' END
            WHEN 'action.requested' THEN 'command'
            WHEN 'action.finished' THEN
                CASE json_extract(e.payload_json, '$.outcome') WHEN 'failed' THEN 'error' END
            WHEN 'artifact.changed' THEN 'edit'
            WHEN 'diagnostic.observed' THEN 'error'
        END AS role,
        CASE json_extract(e.payload_json, '$.kind')
            WHEN 'message.created' THEN
                trim(json_extract(e.payload_json, '$.content.redacted_excerpt'))
            WHEN 'action.requested' THEN
                json_extract(e.payload_json, '$.tool_name') || ' ' ||
                substr(json_extract(e.payload_json, '$.input.redacted_excerpt'), 1, 1000)
            WHEN 'action.finished' THEN
                substr(json_extract(e.payload_json, '$.output.redacted_excerpt'), 1, 400)
            WHEN 'artifact.changed' THEN
                json_extract(e.payload_json, '$.operation') || ' ' ||
                json_extract(e.payload_json, '$.path.redacted_excerpt')
            WHEN 'diagnostic.observed' THEN
                substr(json_extract(e.payload_json, '$.message.redacted_excerpt'), 1, 400)
        END AS body
    FROM activity_events e
)
WHERE role IS NOT NULL
  AND provider IS NOT NULL
  AND body IS NOT NULL
  AND body <> ''
  -- Context the harness injects into a user turn is not something the user
  -- typed; it repeats in every session and drowns real hits.
  AND NOT (
      role = 'user' AND (
          body LIKE '<system-reminder>%'
          OR body LIKE '<command-%'
          OR body LIKE '<local-command-%'
          OR body LIKE '<environment_context>%'
          OR body LIKE '<user_instructions>%'
          OR body LIKE '<permissions instructions>%'
          OR body LIKE '# AGENTS.md instructions%'
          OR body LIKE 'Caveat: The messages below were generated%'
      )
  );

CREATE TABLE session_turns (
    event_seq INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'command', 'edit', 'error')),
    body TEXT NOT NULL
) STRICT;

CREATE INDEX session_turns_project_time
    ON session_turns(project_id, occurred_at);
CREATE INDEX session_turns_session
    ON session_turns(session_id, event_seq);

CREATE VIRTUAL TABLE session_search USING fts5(
    body,
    content = 'session_turns',
    content_rowid = 'event_seq',
    tokenize = 'unicode61'
);

CREATE TRIGGER session_turns_after_event_insert
AFTER INSERT ON activity_events
BEGIN
    INSERT INTO session_turns(event_seq, project_id, session_id, provider, occurred_at, role, body)
    SELECT event_seq, project_id, session_id, provider, occurred_at, role, body
    FROM session_turn_source
    WHERE event_seq = NEW.event_seq;
END;

CREATE TRIGGER session_turns_after_event_delete
AFTER DELETE ON activity_events
BEGIN
    DELETE FROM session_turns WHERE event_seq = OLD.event_seq;
END;

CREATE TRIGGER session_search_after_turn_insert
AFTER INSERT ON session_turns
BEGIN
    INSERT INTO session_search(rowid, body) VALUES (NEW.event_seq, NEW.body);
END;

CREATE TRIGGER session_search_after_turn_delete
AFTER DELETE ON session_turns
BEGIN
    INSERT INTO session_search(session_search, rowid, body)
    VALUES ('delete', OLD.event_seq, OLD.body);
END;

INSERT INTO session_turns(event_seq, project_id, session_id, provider, occurred_at, role, body)
SELECT event_seq, project_id, session_id, provider, occurred_at, role, body
FROM session_turn_source;

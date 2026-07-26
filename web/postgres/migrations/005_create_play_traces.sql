-- Durable archive for play traces. The filesystem store under
-- web/data/play-traces/ stays the read path for the running instance; this
-- table is the mirror that survives Railway redeploys (the container
-- filesystem is ephemeral) so human plays are collectable for fine-tuning.
CREATE TABLE IF NOT EXISTS play_traces (
  trace_id text PRIMARY KEY,
  game_id integer NOT NULL,
  game_name text,
  level_id integer,
  player_type text NOT NULL,
  model_id text,
  final_score double precision,
  won boolean NOT NULL DEFAULT false,
  ticks integer,
  action_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS play_traces_game_player_created_idx
  ON play_traces (game_id, player_type, created_at DESC);

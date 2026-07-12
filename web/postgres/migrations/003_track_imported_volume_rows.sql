CREATE TABLE wall_volume_imported_rows (
  wall_post_id uuid PRIMARY KEY,
  source_digest char(64) NOT NULL,
  recorded_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT wall_volume_imported_rows_digest_format CHECK (source_digest ~ '^[0-9a-f]{64}$')
);

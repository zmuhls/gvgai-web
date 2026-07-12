ALTER TABLE wall_posts
  ALTER COLUMN created_at TYPE timestamptz(3) USING created_at,
  ALTER COLUMN created_at SET DEFAULT CURRENT_TIMESTAMP(3);

CREATE TABLE wall_volume_imports (
  source_digest char(64) PRIMARY KEY,
  source_name text NOT NULL,
  source_row_count integer NOT NULL CHECK (source_row_count >= 0),
  imported_row_count integer NOT NULL CHECK (
    imported_row_count >= 0 AND imported_row_count <= source_row_count
  ),
  imported_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT wall_volume_imports_digest_format CHECK (source_digest ~ '^[0-9a-f]{64}$')
);

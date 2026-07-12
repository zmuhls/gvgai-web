CREATE TABLE wall_posts (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  author_name varchar(80) NOT NULL,
  poem text NOT NULL,
  analysis text,
  delete_token_hash char(64) NOT NULL,
  CONSTRAINT wall_posts_author_name_length CHECK (char_length(author_name) BETWEEN 1 AND 80),
  CONSTRAINT wall_posts_poem_length CHECK (char_length(poem) BETWEEN 1 AND 12000),
  CONSTRAINT wall_posts_analysis_length CHECK (analysis IS NULL OR char_length(analysis) <= 16000),
  CONSTRAINT wall_posts_delete_token_hash_format CHECK (delete_token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX wall_posts_created_id_idx
  ON wall_posts (created_at DESC, id DESC);

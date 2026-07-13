CREATE TABLE wall_post_votes (
  post_id uuid NOT NULL REFERENCES wall_posts(id) ON DELETE CASCADE,
  voter_token_hash char(64) NOT NULL,
  vote smallint NOT NULL,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (post_id, voter_token_hash),
  CONSTRAINT wall_post_votes_token_hash_format CHECK (voter_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT wall_post_votes_value CHECK (vote IN (-1, 1))
);

CREATE INDEX wall_post_votes_post_value_idx
  ON wall_post_votes (post_id, vote);

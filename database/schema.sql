CREATE TABLE IF NOT EXISTS daily_draws (
  draw_date DATE NOT NULL,
  user_hash TEXT NOT NULL,
  PRIMARY KEY (draw_date, user_hash)
);

CREATE TABLE IF NOT EXISTS session_draws (
  draw_date DATE NOT NULL,
  session TEXT NOT NULL CHECK (session IN ('morning', 'noon')),
  user_hash TEXT NOT NULL,
  PRIMARY KEY (draw_date, session, user_hash)
);

CREATE INDEX IF NOT EXISTS session_draws_capacity_idx
  ON session_draws (draw_date, session);

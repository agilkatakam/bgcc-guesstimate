-- Vardhan quiz schema. Idempotent: safe to run more than once.

CREATE TABLE IF NOT EXISTS allowlist (
  email text PRIMARY KEY,
  name  text
);

CREATE TABLE IF NOT EXISTS players (
  id            serial PRIMARY KEY,
  email         text UNIQUE NOT NULL,
  name          text,
  pin_hash      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  disqualified  boolean NOT NULL DEFAULT false,
  failed_pins   int NOT NULL DEFAULT 0,
  locked_until  timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text PRIMARY KEY,
  player_id   int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  user_agent  text
);
CREATE INDEX IF NOT EXISTS sessions_player ON sessions(player_id, created_at DESC);

-- kind: 'q' scored/practice question, 'break' (no answers)
CREATE TABLE IF NOT EXISTS questions (
  idx             int PRIMARY KEY,
  kind            text NOT NULL DEFAULT 'q' CHECK (kind IN ('q', 'break')),
  practice        boolean NOT NULL DEFAULT false,
  text            text NOT NULL,
  unit            text NOT NULL DEFAULT '',
  low             double precision,
  high            double precision,
  seconds         int NOT NULL CHECK (seconds > 0),
  reveal_seconds  int NOT NULL DEFAULT 10 CHECK (reveal_seconds >= 0),
  note            text NOT NULL DEFAULT '',
  CHECK (kind = 'break' OR (low > 0 AND high >= low))
);

CREATE TABLE IF NOT EXISTS game (
  id                  int PRIMARY KEY CHECK (id = 1),
  mode                text NOT NULL DEFAULT 'lobby',
  anchor_at           timestamptz,
  anchor_index        int NOT NULL DEFAULT 0,
  paused_at           timestamptz,
  extensions          jsonb NOT NULL DEFAULT '{}',
  reveal_extensions   jsonb NOT NULL DEFAULT '{}',
  max_revealed_index  int NOT NULL DEFAULT -1,
  version             int NOT NULL DEFAULT 1,
  ranges_version      int NOT NULL DEFAULT 1,
  qualify_count       int NOT NULL DEFAULT 0
);
INSERT INTO game (id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS answers (
  player_id   int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  idx         int NOT NULL,
  value       double precision NOT NULL,
  seq         bigint NOT NULL,
  elapsed_ms  int NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, idx)
);

CREATE TABLE IF NOT EXISTS admins (
  name       text PRIMARY KEY,
  pass_hash  text NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash  text PRIMARY KEY,
  admin       text NOT NULL REFERENCES admins(name) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_log (
  id      serial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  admin   text NOT NULL,
  action  text NOT NULL,
  detail  jsonb,
  old_game jsonb
);

CREATE TABLE IF NOT EXISTS admin_attempts (
  ip     text NOT NULL,
  at     timestamptz NOT NULL DEFAULT now()
);

-- One ranking per (revealed item, ranges version). rows filled by whoever claimed it.
CREATE TABLE IF NOT EXISTS rank_snapshot (
  key          text PRIMARY KEY,
  started_at   timestamptz NOT NULL DEFAULT now(),
  done         boolean NOT NULL DEFAULT false,
  through_idx  int NOT NULL,
  player_count int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rank_rows (
  key        text NOT NULL REFERENCES rank_snapshot(key) ON DELETE CASCADE,
  player_id  int NOT NULL,
  rank       int NOT NULL,
  name       text NOT NULL,
  total      int NOT NULL,
  blanks     int NOT NULL,
  eligible   boolean NOT NULL,
  eligible_rank int,
  PRIMARY KEY (key, player_id)
);
CREATE INDEX IF NOT EXISTS rank_rows_rank ON rank_rows(key, rank);

-- ===================== Phase 2: the mystery =====================
-- stage: closed (hidden) | teams (form teams) | play (case file, exhibits, codes) | ended
CREATE TABLE IF NOT EXISTS mystery (
  id               int PRIMARY KEY CHECK (id = 1),
  stage            text NOT NULL DEFAULT 'closed' CHECK (stage IN ('closed', 'teams', 'play', 'ended')),
  submissions_open boolean NOT NULL DEFAULT false,
  max_team_size    int NOT NULL DEFAULT 10,
  max_attempts     int NOT NULL DEFAULT 1,
  version          int NOT NULL DEFAULT 1
);
INSERT INTO mystery (id) VALUES (1) ON CONFLICT DO NOTHING;

-- Who may play the mystery. Empty = any logged-in player.
CREATE TABLE IF NOT EXISTS roster (
  email text PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS teams (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  captain_id  int REFERENCES players(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_name ON teams (lower(name));

CREATE TABLE IF NOT EXISTS team_members (
  player_id  int PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  team_id    int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS team_members_team ON team_members (team_id);

CREATE TABLE IF NOT EXISTS team_invites (
  team_id     int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, email)
);

-- Case file and answer key (markdown), loaded by scripts/manage.ts mystery
CREATE TABLE IF NOT EXISTS mystery_docs (
  key   text PRIMARY KEY,
  body  text NOT NULL
);

CREATE TABLE IF NOT EXISTS clues (
  n            int PRIMARY KEY,
  title        text NOT NULL,
  description  text NOT NULL,
  body         text NOT NULL,
  code         text UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS unlocks (
  team_id    int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  clue_n     int NOT NULL REFERENCES clues(n) ON DELETE CASCADE,
  player_id  int REFERENCES players(id) ON DELETE SET NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, clue_n)
);

CREATE TABLE IF NOT EXISTS code_attempts (
  team_id  int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  at       timestamptz NOT NULL DEFAULT now(),
  ok       boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS code_attempts_team ON code_attempts (team_id, at);

CREATE TABLE IF NOT EXISTS submissions (
  id            serial PRIMARY KEY,
  team_id       int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id     int REFERENCES players(id) ON DELETE SET NULL,
  answers       jsonb NOT NULL,
  submitted_at  timestamptz NOT NULL DEFAULT now(),
  verdict       text CHECK (verdict IN ('correct', 'wrong')),
  claims        jsonb,
  note          text,
  judged_by     text,
  judged_at     timestamptz
);
CREATE INDEX IF NOT EXISTS submissions_time ON submissions (submitted_at, id);

-- ===================== 24 Nov 2026: no auction; teams with a lead; fewest exhibits wins =====================
-- qualify_count 0 = not decided yet (organisers pick the cut-off on the spot).
ALTER TABLE game ALTER COLUMN qualify_count SET DEFAULT 0;
-- Scoring rubric for the guesstimate (NULL = built-in default). See lib/scoring.ts.
ALTER TABLE game ADD COLUMN IF NOT EXISTS scoring jsonb;

ALTER TABLE mystery ALTER COLUMN max_team_size SET DEFAULT 10;
-- tap: a team opens an exhibit on the website (with a confirm). code: a team types a code an organiser gives them.
ALTER TABLE mystery ADD COLUMN IF NOT EXISTS unlock_mode text NOT NULL DEFAULT 'code' CHECK (unlock_mode IN ('tap', 'code'));
-- lead: only the team lead can open exhibits by tapping. anyone: any member can.
ALTER TABLE mystery ADD COLUMN IF NOT EXISTS open_by text NOT NULL DEFAULT 'lead' CHECK (open_by IN ('lead', 'anyone'));
-- Standings are shown to players and on the big screen only after the organisers publish them.
ALTER TABLE mystery ADD COLUMN IF NOT EXISTS results_public boolean NOT NULL DEFAULT false;

-- Teams: captain_id is the team lead. Others join with the team's join code.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS join_code text;
CREATE UNIQUE INDEX IF NOT EXISTS teams_join_code ON teams (join_code);
-- The lead's answer draft, visible to the whole team.
ALTER TABLE teams ADD COLUMN IF NOT EXISTS draft jsonb NOT NULL DEFAULT '{}';
ALTER TABLE teams ADD COLUMN IF NOT EXISTS draft_at timestamptz;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS draft_by int REFERENCES players(id) ON DELETE SET NULL;

-- What the team had opened at the moment it submitted (the count that ranks it).
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS opened int;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS opened_list jsonb;
-- One submission per team, enforced by the database.
DO $$ BEGIN
  CREATE UNIQUE INDEX IF NOT EXISTS submissions_one_per_team ON submissions (team_id);
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'old duplicate submissions exist; reset the mystery to add the one-per-team index';
END $$;

-- Wrong join codes, for rate limiting.
CREATE TABLE IF NOT EXISTS join_attempts (
  player_id  int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  ok         boolean NOT NULL
);
CREATE INDEX IF NOT EXISTS join_attempts_player ON join_attempts (player_id, at);

-- Admin login throttle also counts per admin name (so rotating addresses doesn't help).
ALTER TABLE admin_attempts ADD COLUMN IF NOT EXISTS name text;
CREATE INDEX IF NOT EXISTS admin_attempts_ip ON admin_attempts (ip, at);

-- ===================== 24 Nov 2026 (2): sections + weights, countdown, lobby note; Round 2 by code, answers offline =====================
-- section: shown with the question ("Easy", "Medium", "Hard"). weight: points are multiplied by it.
-- answer: the model answer shown at the reveal (low/high = the band scored as "inside").
ALTER TABLE questions ADD COLUMN IF NOT EXISTS section text NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN IF NOT EXISTS weight double precision NOT NULL DEFAULT 1 CHECK (weight > 0 AND weight <= 100);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS answer double precision;
-- Text on the lobby screen before the start, e.g. "Starts around 5:10 to 5:15 PM".
ALTER TABLE game ADD COLUMN IF NOT EXISTS lobby_note text NOT NULL DEFAULT '';
-- Weighted totals can be fractional.
ALTER TABLE rank_rows ALTER COLUMN total TYPE double precision;
-- Round 2: exhibits open with codes from the organisers; answers are given in person.
ALTER TABLE mystery ALTER COLUMN unlock_mode SET DEFAULT 'code';
ALTER TABLE mystery ADD COLUMN IF NOT EXISTS answers_online boolean NOT NULL DEFAULT false;
-- 0 = no limit on how many teams players can create.
ALTER TABLE mystery ADD COLUMN IF NOT EXISTS max_teams int NOT NULL DEFAULT 0 CHECK (max_teams >= 0 AND max_teams <= 500);
-- The cut (qualify_count) is chosen privately; phones and the projector see it only once announced.
ALTER TABLE game ADD COLUMN IF NOT EXISTS qualify_announced boolean NOT NULL DEFAULT false;
-- A player the lead removed can't rejoin that team (the team also gets a new join code).
CREATE TABLE IF NOT EXISTS team_bans (
  team_id    int NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  player_id  int NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, player_id)
);
-- Wrong exhibit codes are limited per player (a team-wide limit let one person lock out their whole team).
ALTER TABLE code_attempts ADD COLUMN IF NOT EXISTS player_id int REFERENCES players(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS code_attempts_player ON code_attempts (player_id, at);

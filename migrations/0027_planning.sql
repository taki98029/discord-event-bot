-- Candidate surveys are independent from attendance occurrences.
CREATE TABLE planning_plans (
 id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
 data TEXT NOT NULL CHECK(json_valid(data)), mutation TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reminder_checked_at TEXT
);
CREATE INDEX planning_guild ON planning_plans(guild_id);
CREATE TABLE planning_history (
 id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL REFERENCES planning_plans(id),
 kind TEXT NOT NULL, user_id TEXT, before_data TEXT NOT NULL, after_data TEXT NOT NULL,
 reason TEXT NOT NULL DEFAULT '', changed_at TEXT NOT NULL
);
CREATE TABLE planning_occurrences (
 occurrence_id INTEGER PRIMARY KEY REFERENCES occurrences(id),
 plan_id TEXT NOT NULL REFERENCES planning_plans(id), slot_id TEXT NOT NULL
);
CREATE TABLE planning_roster (
 occurrence_id INTEGER NOT NULL REFERENCES planning_occurrences(occurrence_id),
 user_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('参加','不参加','未定','除外')),
 duty TEXT NOT NULL DEFAULT '', PRIMARY KEY(occurrence_id,user_id)
);
CREATE TABLE planning_deliveries (
 id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES planning_plans(id),
 kind TEXT NOT NULL, slot_id TEXT, channel_id TEXT NOT NULL, payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled')),
 message_id TEXT, thread_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX planning_delivery_status ON planning_deliveries(status);
CREATE TABLE planning_sessions (
 plan_id TEXT NOT NULL REFERENCES planning_plans(id), user_id TEXT NOT NULL,
 data TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(plan_id,user_id)
);
CREATE TABLE planning_cycles (
 id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 next_date TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE planning_tasks (
 id TEXT PRIMARY KEY, cycle_id TEXT NOT NULL REFERENCES planning_cycles(id),
 due_date TEXT NOT NULL, plan_id TEXT NOT NULL UNIQUE REFERENCES planning_plans(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','skipped')),
 UNIQUE(cycle_id,due_date)
);

CREATE INDEX planning_slot_delivery ON planning_deliveries(plan_id,slot_id,status);
CREATE INDEX planning_task_cycle ON planning_tasks(cycle_id,status,due_date);

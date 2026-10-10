-- Bounded role scans live with their plan; keep bulk membership data out of global config reads.
ALTER TABLE planning_plans ADD COLUMN audience_progress TEXT CHECK(audience_progress IS NULL OR json_valid(audience_progress));

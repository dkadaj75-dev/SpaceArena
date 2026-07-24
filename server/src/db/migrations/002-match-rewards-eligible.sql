-- Anti-farming (3a): flag whether a recorded match granted progression. 1 =
-- rewards granted; 0 = ineligible (e.g. client-overridden solo room). Existing
-- rows default to 1 (all prior matches were normal).

ALTER TABLE match_results ADD COLUMN rewards_eligible INTEGER NOT NULL DEFAULT 1;

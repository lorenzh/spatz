// Row contract spatz-eval-row/1 (GitHub issue #68): what the testbench writes and spatz imports.
// A breaking change bumps the version; additive fields are ignored by readers.
import { TASK_TYPES, type TaskType } from "./types.ts";

export const EVAL_ROW_SCHEMA = "spatz-eval-row/1";

/** Taxonomy v2 values a bench row may carry: every TASK_TYPES value except `other`. */
export const EVAL_ROW_TASK_TYPES = TASK_TYPES.filter(
	(t) => t !== "other",
) as readonly Exclude<TaskType, "other">[];

export const EVAL_ROW_FIELDS = [
	"schema",
	"run_id",
	"bench_version",
	"task_id",
	"task_version",
	"task_type",
	"difficulty",
	"criticality",
	"harness",
	"agent_version",
	"model",
	"effort",
	"answered_model",
	"model_version",
	"attempt",
	"result",
	"check",
	"judge",
	"duration_s",
	"tokens",
	"cost_usd",
	"started_at",
	"contributor",
	"verified",
] as const;

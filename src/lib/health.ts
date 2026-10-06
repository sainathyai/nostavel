// What a deployed copy of this app says about itself.
//
// WHY. docs/production-readiness.md §5 has had "No health check endpoint" on it
// since the audit. The reason it now matters: a delivery pipeline has to decide
// whether the copy it just started is worth sending visitors to, and the only
// honest way to decide is to ask the copy. Without this, "deployed" and
// "working" are the same guess.
//
// TWO AUDIENCES, TWO ANSWERS. Anyone may ask whether this copy is up, which
// version it is and whether it is on the supplier's sandbox — a public
// repository means the commit is public anyway, and "is it up" is the question a
// monitor asks every minute without credentials. Everything more specific
// (exactly which secret is missing, whether the database is reachable) needs the
// operations secret, for two different reasons: the list of problems is a map of
// what is wrong with the deploy, and the database probe lets a caller make this
// app query its database on demand, which is a lever worth not handing to
// strangers.
//
// The shape is built here, not in the route, because the delivery pipeline
// asserts on it: "refuse to promote a copy whose supplier key is live" is a
// money rule, and a money rule belongs somewhere a test can reach it rather
// than inside a request handler.
import { appEnv, configProblems, supplierMode, type ConfigProblem, type Env, type SupplierMode } from "./deploy-config";

/** Result of the optional database probe. */
export type DatabaseCheck = "ok" | "unreachable" | "not-checked";

export type PublicHealth = {
  /** Safe to serve traffic: nothing fatal, and the database answered if asked. */
  ok: boolean;
  /** Which environment this process believes it is ("local", "uat", ...). */
  env: string;
  /** The commit this image was built from, or "unknown" if it was not baked in. */
  sha: string;
  supplier: SupplierMode;
};

export type DetailedHealth = PublicHealth & {
  problems: ConfigProblem[];
  database: DatabaseCheck;
};

export type HealthInput = {
  env: Env;
  /** Include the problem list and the database result. Needs the operations secret. */
  detail: boolean;
  database: DatabaseCheck;
};

export function buildHealth(input: HealthInput & { detail: true }): DetailedHealth;
export function buildHealth(input: HealthInput & { detail: false }): PublicHealth;
export function buildHealth(input: HealthInput): PublicHealth | DetailedHealth;
export function buildHealth(input: HealthInput): PublicHealth | DetailedHealth {
  const problems = configProblems(input.env);
  const ok = !problems.some((p) => p.severity === "fatal") && input.database !== "unreachable";

  const base: PublicHealth = {
    ok,
    env: appEnv(input.env),
    sha: (input.env.APP_SHA ?? "").trim() || "unknown",
    supplier: supplierMode(input.env),
  };

  // A warning is still worth reporting to whoever can see the detail — "no email
  // key" is exactly the kind of thing that is invisible until a guest does not
  // get their confirmation.
  return input.detail ? { ...base, problems, database: input.database } : base;
}

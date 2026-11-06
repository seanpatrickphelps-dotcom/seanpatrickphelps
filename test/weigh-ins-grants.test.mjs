import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sqlPath = join(root, "supabase/migrations/20261107_train_weigh_ins.sql");
const sql = readFileSync(sqlPath, "utf8").toLowerCase();

function stripComments(text) {
  return text.replace(/--[^\n]*/g, "");
}

test("weigh_ins migration revokes truncate from anon and authenticated", () => {
  const body = stripComments(sql);
  const revoke = body.indexOf("revoke all on table public.weigh_ins from anon, authenticated");
  const grantAuth = body.indexOf("grant select, insert, update, delete on table public.weigh_ins to authenticated");
  const grantService = body.indexOf("grant select, insert, update, delete on table public.weigh_ins to service_role");
  assert.ok(revoke > body.indexOf("create table"), "revoke runs after the table exists");
  assert.ok(grantAuth > revoke, "authenticated DML is granted only after the broad revoke");
  assert.ok(grantService > revoke, "service_role DML is granted only after the broad revoke");
  assert.equal(body.includes("revoke all on table public.weigh_ins from service_role"), false);
  assert.equal(/grant\s+[^;]*truncate[^;]*to\s+(anon|authenticated)/i.test(body), false);
  assert.match(body, /enable row level security/);
  assert.match(body, /auth\.uid\(\) = user_id/);
});

function psql(db, statement) {
  return execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", db, "-At", "-c", statement], { encoding: "utf8" });
}

function postgresUp() {
  try {
    execFileSync("sudo", ["-u", "postgres", "psql", "-At", "-c", "select 1"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("applied weigh_ins grants match the revoke, and rerunning keeps rows", { skip: postgresUp() ? false : "local Postgres is not running" }, () => {
  const db = "weigh_grant_regression";
  execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${db}`], { stdio: "ignore" });
  execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE ${db}`], { stdio: "ignore" });
  try {
    psql(db, `
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
      END $$;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated, service_role;
    `);
    execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", db, "-f", sqlPath], { stdio: "ignore" });
    const priv = (role, name) => psql(db, `SELECT has_table_privilege('${role}', 'public.weigh_ins', '${name}')`).trim();
    for (const name of ["SELECT", "INSERT", "UPDATE", "DELETE"]) assert.equal(priv("authenticated", name), "t", name);
    for (const name of ["TRUNCATE", "REFERENCES", "TRIGGER"]) assert.equal(priv("authenticated", name), "f", name);
    for (const name of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) assert.equal(priv("anon", name), "f", "anon " + name);
    assert.equal(priv("service_role", "SELECT"), "t");
    assert.equal(priv("service_role", "INSERT"), "t");
    assert.equal(psql(db, "SELECT relrowsecurity FROM pg_class WHERE oid = 'public.weigh_ins'::regclass").trim(), "t");

    psql(db, "GRANT authenticated TO postgres; GRANT anon TO postgres");
    psql(db, `SET ROLE authenticated; INSERT INTO public.weigh_ins (user_id, log_date, pounds) VALUES (auth.uid(), '2026-11-06', 245.6); INSERT INTO public.weigh_ins (user_id, log_date, pounds) VALUES (auth.uid(), '2026-11-06', 240) ON CONFLICT (user_id, log_date) DO UPDATE SET pounds = EXCLUDED.pounds`);
    assert.equal(psql(db, "SELECT count(*)::text || ' ' || max(pounds)::text FROM public.weigh_ins").trim(), "1 240");
    let denied = false;
    try {
      psql(db, "SET ROLE authenticated; INSERT INTO public.weigh_ins (user_id, log_date, pounds) VALUES ('22222222-2222-2222-2222-222222222222', '2026-11-06', 180)");
    } catch { denied = true; }
    assert.equal(denied, true);
    try { psql(db, "SET ROLE authenticated; TRUNCATE public.weigh_ins"); assert.fail("truncate should fail"); } catch { /* denied */ }
    try { psql(db, "SET ROLE anon; TRUNCATE public.weigh_ins"); assert.fail("anon truncate should fail"); } catch { /* denied */ }

    execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-d", db, "-f", sqlPath], { stdio: "ignore" });
    assert.equal(psql(db, "SELECT count(*) FROM public.weigh_ins").trim(), "1");
    assert.equal(priv("authenticated", "TRUNCATE"), "f");
    assert.equal(priv("anon", "TRUNCATE"), "f");
  } finally {
    execFileSync("sudo", ["-u", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${db} WITH (FORCE)`], { stdio: "ignore" });
  }
});

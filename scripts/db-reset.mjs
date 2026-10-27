// Drops and recreates the local demo database, then applies migrations. Demo/dev only.
import { execSync } from "node:child_process";
const host = process.env.PGHOST ?? "/tmp";
const run = (sql) => execSync(`psql -h ${host} -U postgres -v ON_ERROR_STOP=1 -c "${sql}"`, { stdio: "inherit" });
run("drop database if exists fundingenvoy with (force)");
run("create database fundingenvoy");
execSync("pnpm --filter @fe/db migrate", { stdio: "inherit" });

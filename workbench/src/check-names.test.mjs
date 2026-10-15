import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

test("name check scans the default scope and --all without exposing names", t => {
  const root = mkdtempSync(join(tmpdir(), "wb-check-names-"));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith("wb-check-names-"));
    rmSync(root, { recursive: true, force: true });
  });
  const source = join(root, "workbench", "src");
  mkdirSync(source, { recursive: true });
  copyFileSync(new URL("./check-names.mjs", import.meta.url), join(source, "check-names.mjs"));
  const name = "SYNTHETIC_STUDENT";
  writeFileSync(join(source, "private-seed.json"), JSON.stringify({ students: [{ name }] }));
  writeFileSync(join(source, "app.html"), "public content\n");
  writeFileSync(join(root, "AGENTS.md"), "public instructions\n");
  writeFileSync(join(root, "outside.txt"), name);
  execFileSync("git", ["init", "--quiet"], { cwd: root });

  const empty = spawnSync(process.execPath, [join(source, "check-names.mjs")], { cwd: root, encoding: "utf8" });
  assert.ifError(empty.error);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /검사할 파일이 0개/);
  assert.ok(!(empty.stdout + empty.stderr).includes(name));
  execFileSync("git", ["add", "AGENTS.md", "workbench/src/check-names.mjs", "workbench/src/app.html", "outside.txt"], { cwd: root });

  const run = (...args) => {
    const result = spawnSync(process.execPath, [join(source, "check-names.mjs"), ...args], { cwd: root, encoding: "utf8" });
    assert.ifError(result.error);
    assert.equal(result.stderr, "");
    assert.ok(!result.stdout.includes(name), "student names must not appear in output");
    return result;
  };
  let result = run();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0건 .*파일 3개/);

  writeFileSync(join(source, "app.html"), `public content\n${name}\n`);
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /workbench\/src\/app\.html:2/);
  writeFileSync(join(source, "app.html"), "public content\n");

  writeFileSync(join(root, "AGENTS.md"), name);
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stdout, /AGENTS\.md:1/);
  writeFileSync(join(root, "AGENTS.md"), "public instructions\n");

  result = run("--all");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /outside\.txt:1/);
  assert.match(result.stdout, /파일 4개/);
  writeFileSync(join(root, "outside.txt"), "public content\n");
  result = run("--all");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0건 .*파일 4개/);
});

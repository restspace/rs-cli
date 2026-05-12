import { assertEquals } from "std/assert/mod.ts";
import { planActions } from "./sync.ts";

Deno.test("planActions supports add and delete on remote", async () => {
  const { actions, stats } = await planActions(
    new Map([
      ["local-only.txt", { mtimeMs: 1000 }],
    ]),
    new Map([
      ["remote-only.txt", { mtimeMs: 2000 }],
    ]),
    new Map(),
    ".",
    [],
    ["add", "delete"],
  );

  assertEquals(actions, [
    {
      type: "upload",
      relativePath: "local-only.txt",
      localMtimeMs: 1000,
      reason: "new local file (1970-01-01T00:00:01.000Z)",
    },
    {
      type: "deleteRemote",
      relativePath: "remote-only.txt",
      remoteMtimeMs: 2000,
      reason: "remote-only file",
    },
  ]);
  assertEquals(stats.ignored, 0);
});

Deno.test("planActions supports add and delete on local", async () => {
  const { actions, stats } = await planActions(
    new Map([
      ["local-only.txt", { mtimeMs: 1000 }],
    ]),
    new Map([
      ["remote-only.txt", { mtimeMs: 2000 }],
    ]),
    new Map(),
    ".",
    ["add", "delete"],
    [],
  );

  assertEquals(actions, [
    {
      type: "deleteLocal",
      relativePath: "local-only.txt",
      localMtimeMs: 1000,
      reason: "local-only file",
    },
    {
      type: "download",
      relativePath: "remote-only.txt",
      remoteMtimeMs: 2000,
      reason: "new remote file (1970-01-01T00:00:02.000Z)",
    },
  ]);
  assertEquals(stats.ignored, 0);
});

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { join, normalize } from "std/path/mod.ts";
import {
  findProjectConfigPath,
  getConfigPath,
  loadConfig,
  saveConfig,
} from "./config-store.ts";

let envLock = Promise.resolve();

async function withEnvLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = envLock.then(fn, fn);
  envLock = run.then(() => undefined, () => undefined);
  return await run;
}

async function withTempHome<T>(
  fn: (homeDir: string) => Promise<T>,
): Promise<T> {
  return await withEnvLock(async () => {
    const tempDir = await Deno.makeTempDir();
    const previousHome = Deno.env.get("HOME");
    const previousUserProfile = Deno.env.get("USERPROFILE");
    const previousHomePath = Deno.env.get("HOMEPATH");

    Deno.env.set("HOME", tempDir);
    Deno.env.delete("USERPROFILE");
    Deno.env.delete("HOMEPATH");

    try {
      return await fn(tempDir);
    } finally {
      if (previousHome === undefined) {
        Deno.env.delete("HOME");
      } else {
        Deno.env.set("HOME", previousHome);
      }

      if (previousUserProfile === undefined) {
        Deno.env.delete("USERPROFILE");
      } else {
        Deno.env.set("USERPROFILE", previousUserProfile);
      }

      if (previousHomePath === undefined) {
        Deno.env.delete("HOMEPATH");
      } else {
        Deno.env.set("HOMEPATH", previousHomePath);
      }

      await Deno.remove(tempDir, { recursive: true });
    }
  });
}

Deno.test("findProjectConfigPath walks up to the nearest rsconfig.json", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const projectRoot = join(tempDir, "workspace");
    const nestedProject = join(projectRoot, "apps", "site");
    const leafDir = join(nestedProject, "src", "pages");

    await Deno.mkdir(leafDir, { recursive: true });
    await Deno.writeTextFile(
      join(projectRoot, "rsconfig.json"),
      JSON.stringify({ url: "https://root.example" }, null, 2),
    );
    await Deno.writeTextFile(
      join(nestedProject, "rsconfig.json"),
      JSON.stringify({ url: "https://nested.example" }, null, 2),
    );

    const found = await findProjectConfigPath(leafDir);
    assertEquals(
      normalize(found ?? ""),
      normalize(join(nestedProject, "rsconfig.json")),
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadConfig merges project overrides with host-scoped cached auth", async () => {
  await withTempHome(async () => {
    await saveConfig({
      host: "https://global.example/",
      credentials: {
        email: "global@example.com",
        password: "global-password",
      },
      auth: {
        token: "cached-token",
        expiry: 4_102_444_800,
        host: "https://project.example/",
      },
    });

    const cwd = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(cwd, "rsconfig.json"),
        JSON.stringify(
          {
            url: "https://project.example/",
            login: {
              email: "project@example.com",
            },
          },
          null,
          2,
        ),
      );

      const config = await loadConfig({ cwd });
      assertEquals(config.host, "https://project.example");
      assertEquals(config.credentials?.email, "project@example.com");
      assertEquals(config.credentials?.password, "global-password");
      assertEquals(config.auth?.token, "cached-token");
      assertEquals(config.auth?.host, "https://project.example/");
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });
});

Deno.test("loadConfig auto-login uses rsconfig.json credentials and caches auth only", async () => {
  await withTempHome(async () => {
    const cwd = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(
        join(cwd, "rsconfig.json"),
        JSON.stringify(
          {
            url: "https://tenant.restspace.io/",
            login: {
              email: "agent@example.com",
              password: "project-secret",
            },
          },
          null,
          2,
        ),
      );

      const loginCalls: Array<
        { host: string; email: string; password: string }
      > = [];
      const config = await loadConfig({
        cwd,
        autoLogin: true,
        login: async (host, email, password) => {
          loginCalls.push({ host, email, password });
          return {
            token: "fresh-token",
            expiry: 4_102_444_800,
          };
        },
      });

      assertEquals(loginCalls, [{
        host: "https://tenant.restspace.io",
        email: "agent@example.com",
        password: "project-secret",
      }]);
      assertEquals(config.host, "https://tenant.restspace.io");
      assertEquals(config.auth?.token, "fresh-token");
      assertEquals(config.credentials?.email, "agent@example.com");
      assertEquals(config.credentials?.password, "project-secret");

      const savedRaw = JSON.parse(await Deno.readTextFile(getConfigPath())) as {
        credentials?: { password?: string };
        auth?: { token?: string; host?: string };
      };
      assert(!savedRaw.credentials?.password);
      assertEquals(savedRaw.auth?.token, "fresh-token");
      assertEquals(savedRaw.auth?.host, "https://tenant.restspace.io");
    } finally {
      await Deno.remove(cwd, { recursive: true });
    }
  });
});

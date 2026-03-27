import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { findCatalogueEntry, loadCatalogue } from "./discover.ts";
import type { ApiClient } from "../lib/api-client.ts";

Deno.test("loadCatalogue fetches the service catalogue endpoint", async () => {
  const calls: Array<[string, string]> = [];
  const client = {
    request: async (method: string, path: string) => {
      calls.push([method, path]);
      return {
        status: 200,
        headers: {},
        data: {
          services: [{ name: "Data Service" }],
          adapters: [{ name: "MongoDbDataAdapter" }],
        },
        durationMs: 1,
      };
    },
  } as ApiClient;

  const catalogue = await loadCatalogue(client);

  assertEquals(calls, [["GET", "/.well-known/restspace/services/catalogue"]]);
  assertEquals(catalogue, {
    services: [{ name: "Data Service" }],
    adapters: [{ name: "MongoDbDataAdapter" }],
  });
});

Deno.test("findCatalogueEntry finds entries by key, name, and basePath", () => {
  const objectCatalogue = {
    data: { name: "Data Service", basePath: "/data" },
    services: { name: "Services Service" },
  };
  const arrayCatalogue = [
    { key: "template", name: "Template Service", basePath: "/templates" },
  ];

  assertEquals(findCatalogueEntry(objectCatalogue, "data"), {
    key: "data",
    entry: { name: "Data Service", basePath: "/data" },
  });
  assertEquals(findCatalogueEntry(objectCatalogue, "Services Service"), {
    key: "services",
    entry: { name: "Services Service" },
  });
  assertEquals(findCatalogueEntry(arrayCatalogue, "/templates"), {
    key: "/templates",
    entry: {
      key: "template",
      name: "Template Service",
      basePath: "/templates",
    },
  });
});

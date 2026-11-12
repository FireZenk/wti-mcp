import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { WtiClient } from "../src/client.js";
import { createServer, type ServerOptions } from "../src/server.js";
import { FakeWti, PROJECT } from "./fake-wti.js";

const STRINGS = "/api/projects/current/strings";

/** A fake WTI that already serves the project (locales en, de, fr; master file 10). */
const fakeWti = () => new FakeWti().on("GET", "/api/projects/current", { json: PROJECT });

async function connect(fake: FakeWti, options: ServerOptions = {}): Promise<Client> {
  const wti = new WtiClient({ token: "wti_pw_fake", fetch: fake.fetch, sleep: async () => {} });
  const server = createServer(wti, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  return { isError: result.isError === true, text, json: () => JSON.parse(text) };
}

describe("tool registration", () => {
  it("hides write tools in read-only mode and delete tools unless allowed", async () => {
    const names = async (options: ServerOptions) =>
      (await (await connect(fakeWti(), options)).listTools()).tools.map((tool) => tool.name).sort();

    expect(await names({ readOnly: true })).toEqual([
      "wti_download_file",
      "wti_get_project",
      "wti_get_stats",
      "wti_get_string",
      "wti_list_strings",
      "wti_search_glossary",
    ]);
    const readWrite = await names({});
    expect(readWrite).toHaveLength(14);
    expect(readWrite.filter((name) => name.includes("delete") || name.includes("remove"))).toEqual([]);
    const withDeletes = await names({ allowDelete: true });
    expect(withDeletes).toEqual(expect.arrayContaining(["wti_delete_string", "wti_delete_term", "wti_remove_locale"]));
    expect(await names({ readOnly: true, allowDelete: true })).toHaveLength(6);
  });
});

describe("strings", () => {
  it("wti_get_project groups target files under their master file", async () => {
    const fake = fakeWti().on("GET", "/api/projects/current", { json: PROJECT });
    const result = (await call(await connect(fake), "wti_get_project")).json();
    expect(result.source_locale).toBe("en");
    expect(result.target_locales).toEqual(["de", "fr"]);
    expect(result.master_files[0].master_file_id).toBe(10);
    expect(result.master_files[0].targets.map((target: { locale: string }) => target.locale)).toEqual(["de", "fr"]);
  });

  it("wti_get_string finds the exact key and returns translations per locale", async () => {
    const fake = fakeWti()
      .on("GET", STRINGS, {
        json: [
          { id: 5, key: "home_title_long", file: { id: 10 } },
          { id: 6, key: "home_title", file: { id: 10 } },
        ],
      })
      .on("GET", `${STRINGS}/6`, {
        json: {
          id: 6,
          key: "home_title",
          status: "Current",
          labels: "android, home",
          file: { id: 10 },
          translations: [
            { locale: "en", text: "Book again", status: "status_proofread" },
            { locale: "de", text: "Erneut buchen", status: "status_unproofread" },
          ],
        },
      });
    const result = await call(await connect(fake), "wti_get_string", { key: "home_title" });

    expect(result.isError).toBe(false);
    expect(result.json()).toMatchObject({
      id: 6,
      key: "home_title",
      labels: ["android", "home"],
      translations: { en: { text: "Book again" }, de: { text: "Erneut buchen", status: "status_unproofread" } },
    });
    expect(fake.find("GET", STRINGS)[0]?.url.searchParams.get("filters[key]")).toBe("home_title");
    expect(fake.find("GET", `${STRINGS}/6`)[0]?.url.searchParams.get("locale")).toBe("*");
  });

  it("wti_get_string explains when a key doesn't exist", async () => {
    const fake = fakeWti().on("GET", STRINGS, { json: [] });
    const result = await call(await connect(fake), "wti_get_string", { key: "missing_key" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No string with key "missing_key"/);
  });

  it("rejects locales the project doesn't have, suggesting the right code", async () => {
    const fake = new FakeWti().on("GET", "/api/projects/current", {
      json: { project: { ...PROJECT.project, target_locales: [{ code: "de-DE" }, { code: "de-AT" }, { code: "fr-FR" }] } },
    });
    const client = await connect(fake);

    const result = await call(client, "wti_get_string", { string_id: 6, locales: "de" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Unknown locale "de" \(did you mean de-DE or de-AT\?\)/);
    const stats = await call(client, "wti_get_stats", { locale: "xx" });
    expect(stats.text).toMatch(/Project locales: de-AT, de-DE, en, fr-FR/);
    expect(fake.requests.every((request) => request.url.pathname === "/api/projects/current")).toBe(true);
  });

  it("wti_list_strings requires a locale for translation-state filters", async () => {
    const fake = fakeWti().on("GET", STRINGS, { json: [{ id: 1, key: "a", translations: { locale: "de", text: null } }] });
    const client = await connect(fake);

    expect((await call(client, "wti_list_strings", { status: "to_translate" })).isError).toBe(true);
    const result = (await call(client, "wti_list_strings", { status: "to_translate", locale: "de", label: "android" })).json();
    expect(result).toMatchObject({ count: 1, next_page: null });
    const query = fake.find("GET", STRINGS)[0]?.url.searchParams;
    expect(query?.get("filters[status]")).toBe("to_translate");
    expect(query?.get("filters[label]")).toBe("android");
    expect(query?.get("locale")).toBe("de");
  });

  it("wti_create_string uses the only master file and the source locale", async () => {
    const fake = fakeWti()
      .on("GET", "/api/projects/current", { json: PROJECT })
      .on("GET", STRINGS, { json: [] })
      .on("POST", STRINGS, (request) => ({ status: 201, json: { id: 99, ...(request.json as object), file: { id: 10 } } }));
    const result = await call(await connect(fake), "wti_create_string", {
      key: "rebook_title",
      source_text: "Book again",
      translations: [{ locale: "de", text: "Erneut buchen", status: "status_proofread" }],
      labels: ["android", "android", "release-5.31"],
      dev_comment: "Card title on Home",
    });

    expect(result.isError).toBe(false);
    expect(fake.find("POST", STRINGS)[0]?.json).toEqual({
      key: "rebook_title",
      file: { id: 10 },
      dev_comment: "Card title on Home",
      labels: "android,release-5.31",
      translations: [
        { locale: "en", text: "Book again" },
        { locale: "de", text: "Erneut buchen", status: "status_proofread" },
      ],
    });
    expect(result.json().created.id).toBe(99);
  });

  it("wti_create_string marks plurals and refuses existing keys", async () => {
    const fake = fakeWti()
      .on("GET", "/api/projects/current", { json: PROJECT })
      .on("GET", STRINGS, (request) => ({
        json: request.url.searchParams.get("filters[key]") === "taken" ? [{ id: 1, key: "taken", file: { id: 10 } }] : [],
      }))
      .on("POST", STRINGS, { status: 201, json: { id: 2, key: "bookings_count", plural: true } });
    const client = await connect(fake);

    const duplicate = await call(client, "wti_create_string", { key: "taken", source_text: "x" });
    expect(duplicate.isError).toBe(true);
    expect(duplicate.text).toMatch(/already exists/);

    await call(client, "wti_create_string", { key: "bookings_count", source_text: { one: "%d booking", other: "%d bookings" } });
    expect(fake.find("POST", STRINGS)[0]?.json).toMatchObject({ plural: true });
  });

  it("wti_update_string adds and removes labels without dropping the others", async () => {
    const fake = fakeWti()
      .on("GET", STRINGS, { json: [{ id: 6, key: "home_title", file: { id: 10 } }] })
      .on("GET", `${STRINGS}/6`, { json: { id: 6, key: "home_title", labels: "android, old" } })
      .on("PUT", `${STRINGS}/6`, { status: 202 });
    const result = await call(await connect(fake), "wti_update_string", {
      key: "home_title",
      add_labels: ["release-5.31"],
      remove_labels: ["old"],
      status: "hidden",
    });

    expect(result.isError).toBe(false);
    expect(fake.find("PUT", `${STRINGS}/6`)[0]?.json).toEqual({ status: "Hidden", labels: "android,release-5.31" });
  });

  it("wti_set_translations reports per-locale failures", async () => {
    const fake = fakeWti()
      .on("POST", `${STRINGS}/6/locales/de/translations`, { status: 201 })
      .on("POST", `${STRINGS}/6/locales/fr/translations`, {
        status: 406,
        json: { error: "Error saving translation", description: "Validation check failed: placeholder %s missing" },
      });
    const result = await call(await connect(fake), "wti_set_translations", {
      string_id: 6,
      translations: [
        { locale: "de", text: "Hallo %s" },
        { locale: "fr", text: "Bonjour" },
      ],
      minor_change: true,
    });

    expect(result.isError).toBe(false);
    const { results } = result.json();
    expect(results[0]).toEqual({ locale: "de", saved: true });
    expect(results[1].saved).toBe(false);
    expect(results[1].error).toMatch(/placeholder %s missing/);
    expect(fake.find("POST", `${STRINGS}/6/locales/de/translations`)[0]?.json).toEqual({ text: "Hallo %s", minor_change: "true" });
  });
});

describe("files", () => {
  const FILE_EN = "/api/projects/current/files/10/locales/en";
  const FILE_DE = "/api/projects/current/files/10/locales/de";

  function localFile(content: string): string {
    const path = join(mkdtempSync(join(tmpdir(), "wti-mcp-")), "strings.xml");
    writeFileSync(path, content);
    return path;
  }

  const xml = (...lines: string[]) => ["<resources>", ...lines.map((line) => `    ${line}`), "</resources>"].join("\n");

  it("wti_upload_file first shows what differs from WebTranslateIt's copy and uploads nothing", async () => {
    // Someone changed "b" and added "c" on WebTranslateIt; locally "b" was edited and "d" added.
    const remote = xml('<string name="a">A</string>', '<string name="b">Theirs</string>', '<string name="c">C</string>');
    const path = localFile(xml('<string name="a">A</string>', '<string name="b">Mine</string>', '<string name="d">D</string>'));
    const fake = fakeWti().on("GET", FILE_EN, { text: remote }).on("PUT", FILE_EN, { status: 202 });
    const result = (await call(await connect(fake), "wti_upload_file", { file_id: 10, locale: "en", local_path: path })).json();

    expect(result).toMatchObject({
      status: "preview",
      uploaded: false,
      only_on_webtranslateit: { count: 2, lines: ['3: <string name="b">Theirs</string>', '4: <string name="c">C</string>'] },
      only_in_your_file: { count: 2, lines: ['3: <string name="b">Mine</string>', '4: <string name="d">D</string>'] },
    });
    expect(result.if_you_upload.join(" ")).toMatch(/replacing what is on WebTranslateIt.*only on WebTranslateIt stay/);
    expect(result.confirm).toMatch(/^[0-9a-f]{16}$/);
    expect(fake.find("PUT", FILE_EN)).toHaveLength(0);
  });

  it("wti_upload_file uploads with the preview's token, keeping missing strings by default", async () => {
    const path = localFile(xml('<string name="a">A</string>', '<string name="d">D</string>'));
    const fake = fakeWti().on("GET", FILE_EN, { text: xml('<string name="a">A</string>') }).on("PUT", FILE_EN, { status: 202 });
    const client = await connect(fake);
    const args = { file_id: 10, locale: "en", local_path: path, label: "android" };

    const preview = (await call(client, "wti_upload_file", args)).json();
    const result = (await call(client, "wti_upload_file", { ...args, confirm: preview.confirm })).json();

    expect(result).toMatchObject({ status: "uploaded", uploaded: true, bytes: Buffer.byteLength(xml('<string name="a">A</string>', '<string name="d">D</string>')) });
    const form = fake.find("PUT", FILE_EN)[0]?.form;
    expect(form?.get("ignore_missing")).toBe("true");
    expect(form?.get("merge")).toBe("false");
    expect(form?.get("label")).toBe("android");
    expect((form?.get("file") as File).name).toBe("strings.xml");
  });

  it("wti_upload_file refuses a token from before someone else changed WebTranslateIt's copy", async () => {
    let remote = xml('<string name="a">A</string>');
    const path = localFile(xml('<string name="a">A</string>', '<string name="d">D</string>'));
    const fake = fakeWti().on("GET", FILE_DE, () => ({ text: remote })).on("PUT", FILE_DE, { status: 202 });
    const client = await connect(fake);
    const args = { file_id: 10, locale: "de", local_path: path };

    const first = (await call(client, "wti_upload_file", args)).json();
    remote = xml('<string name="a">A</string>', '<string name="e">Added meanwhile</string>');
    const second = (await call(client, "wti_upload_file", { ...args, confirm: first.confirm })).json();

    expect(second.status).toBe("preview");
    expect(second.note).toMatch(/changed since that preview/);
    expect(second.only_on_webtranslateit.lines).toEqual(['3: <string name="e">Added meanwhile</string>']);
    expect(second.if_you_upload.join(" ")).toMatch(/aren't in your file aren't touched/);
    expect(second.confirm).not.toBe(first.confirm);
    expect(fake.find("PUT", FILE_DE)).toHaveLength(0);
  });

  it("wti_upload_file says when the local file is only behind WebTranslateIt's copy", async () => {
    const remote = xml('<string name="a">A</string>', '<string name="b">Neu</string>');
    const path = localFile(xml('<string name="a">A</string>'));
    const fake = fakeWti().on("GET", FILE_DE, { text: remote }).on("PUT", FILE_DE, { status: 202 });
    const result = (await call(await connect(fake), "wti_upload_file", { file_id: 10, locale: "de", local_path: path })).json();

    expect(result).toMatchObject({ status: "preview", uploaded: false, only_in_your_file: { count: 0 } });
    expect(result.note).toMatch(/behind WebTranslateIt's copy\. Use wti_download_file/);
    expect(fake.find("PUT", FILE_DE)).toHaveLength(0);
  });

  it("wti_upload_file says there's nothing to upload when only order and indentation differ", async () => {
    const remote = xml('<string name="a">A</string>', '<string name="b">B</string>');
    const path = localFile('<resources>\n<string name="b">B</string>\n\n  <string name="a">A</string>\n</resources>\n');
    const fake = fakeWti().on("GET", FILE_EN, { text: remote }).on("PUT", FILE_EN, { status: 202 });
    const result = (await call(await connect(fake), "wti_upload_file", { file_id: 10, locale: "en", local_path: path })).json();

    expect(result).toMatchObject({ status: "unchanged", uploaded: false });
    expect(fake.find("PUT", FILE_EN)).toHaveLength(0);
  });

  it("wti_download_file cuts long content unless saved to disk", async () => {
    const fake = fakeWti().on("GET", "/api/projects/current/files/10/locales/de", { text: "x".repeat(1500) });
    const client = await connect(fake);
    const cut = await call(client, "wti_download_file", { file_id: 10, locale: "de", max_chars: 1000 });
    expect(cut.text).toMatch(/^x{1000}\n…\[cut: 500 more characters/);

    const target = join(mkdtempSync(join(tmpdir(), "wti-mcp-")), "values-de", "strings.xml");
    expect((await call(client, "wti_download_file", { file_id: 10, locale: "de", save_to: target })).json()).toEqual({
      saved_to: target,
      bytes: 1500,
    });
  });
});

describe("glossary", () => {
  it("wti_search_glossary matches text and description and adds translations", async () => {
    const fake = fakeWti()
      .on("GET", "/api/projects/current/terms", {
        json: [
          { id: 1, text: "Treatment" },
          { id: 2, text: "Venue", description: "Place where a treatment happens" },
          { id: 3, text: "Booking" },
        ],
      })
      .on("GET", "/api/projects/current/terms/1/locales/de/translations", {
        // The real API reads statuses back as numbers: 1 approved, 0 proposed, -1 refused.
        json: [
          { id: 9, locale: "de", text: "Behandlung", status: 1 },
          { id: 10, locale: "de", text: "Anwendung", status: -1 },
        ],
      })
      .on("GET", "/api/projects/current/terms/2/locales/de/translations", { json: [] });
    const result = (await call(await connect(fake), "wti_search_glossary", { query: "TREAT", locale: "de" })).json();

    expect(result.matches).toBe(2);
    expect(result.terms).toEqual([
      {
        id: 1,
        text: "Treatment",
        translations: [
          { id: 9, text: "Behandlung", status: "approved" },
          { id: 10, text: "Anwendung", status: "refused" },
        ],
      },
      { id: 2, text: "Venue", description: "Place where a treatment happens", translations: [] },
    ]);
  });

  it("wti_set_term_translation updates the existing translation or creates one", async () => {
    const translations = "/api/projects/current/terms/1/locales/de/translations";
    let existing: unknown[] = [{ id: 9, locale: "de", text: "Behandlung", status: 0 }];
    const fake = fakeWti()
      .on("GET", translations, () => ({ json: existing }))
      .on("PUT", `${translations}/9`, { status: 200 })
      .on("POST", translations, { status: 201 });
    const client = await connect(fake);

    const updated = (await call(client, "wti_set_term_translation", { term_id: 1, locale: "de", text: "Anwendung" })).json();
    expect(updated).toEqual({ term_id: 1, locale: "de", updated_translation_id: 9 });
    expect(fake.find("PUT", `${translations}/9`)[0]?.json).toEqual({ text: "Anwendung" });

    existing = [];
    await call(client, "wti_set_term_translation", { term_id: 1, locale: "de", text: "Behandlung", status: "approved" });
    expect(fake.find("POST", translations)[0]?.json).toEqual({ text: "Behandlung", status: "approved" });
  });

  it("wti_set_term_translation never sends a status on update (WTI answers 500) and says so", async () => {
    const translations = "/api/projects/current/terms/1/locales/de/translations";
    const fake = fakeWti()
      .on("GET", translations, { json: [{ id: 9, locale: "de", text: "Behandlung", status: 0 }] })
      .on("PUT", `${translations}/9`, (request) =>
        (request.json as Record<string, unknown>).status !== undefined ? { status: 500, text: "<html>" } : { status: 200 },
      );
    const result = await call(await connect(fake), "wti_set_term_translation", {
      term_id: 1,
      locale: "de",
      text: "Anwendung",
      status: "approved",
    });

    expect(result.isError).toBe(false);
    expect(fake.find("PUT", `${translations}/9`)[0]?.json).toEqual({ text: "Anwendung" });
    expect(result.json().note).toMatch(/can't change the status/);
  });
});

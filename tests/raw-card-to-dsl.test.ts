import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isRawCardEnvelope, rawCardToDsl } from "../src/index.js";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8"));
}

interface AnyDsl {
  schema?: string;
  config?: Record<string, unknown>;
  body?: Record<string, unknown>;
  header?: Record<string, unknown>;
}

function findElements(dsl: AnyDsl, predicate: (el: Record<string, unknown>) => boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  function walk(v: unknown) {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (predicate(rec)) out.push(rec);
      for (const val of Object.values(rec)) walk(val);
    }
  }
  walk(dsl);
  return out;
}

/** Collect every object key in the tree matching `predicate` (with its path). */
function collectKeys(dsl: unknown, predicate: (key: string) => boolean): string[] {
  const out: string[] = [];
  function walk(v: unknown, path: string) {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (predicate(k)) out.push(`${path}.${k}`);
        walk(val, `${path}.${k}`);
      }
    }
  }
  walk(dsl, "root");
  return out;
}

describe("isRawCardEnvelope", () => {
  it("recognizes the editor-internal envelope", () => {
    const env = loadFixture("grid-images.raw.json");
    expect(isRawCardEnvelope(env)).toBe(true);
  });

  it("rejects non-envelope payloads", () => {
    expect(isRawCardEnvelope(null)).toBe(false);
    expect(isRawCardEnvelope({})).toBe(false);
    expect(isRawCardEnvelope({ schema: "2.0", body: {} })).toBe(false);
    expect(isRawCardEnvelope("string")).toBe(false);
  });
});

describe("rawCardToDsl basic shape", () => {
  it("produces { schema, config, body, header }", () => {
    const dsl = rawCardToDsl(loadFixture("markdown-at.raw.json")) as AnyDsl;
    expect(dsl.schema).toBe("2.0");
    expect(dsl.config).toEqual({ update_multi: true });
    expect(dsl.body).toBeDefined();
    expect(dsl.header).toBeDefined();
  });

  it("returns the input unchanged when it isn't a raw envelope", () => {
    const arg = { schema: "2.0", body: { elements: [] } };
    expect(rawCardToDsl(arg)).toBe(arg);
  });
});

describe("padding / margin projection", () => {
  it("projects column padding from { type:pixels, value } objects to 'Tpx Rpx Bpx Lpx'", () => {
    const dsl = rawCardToDsl(loadFixture("grid-images.raw.json")) as AnyDsl;
    expect(dsl.body?.padding).toMatch(/^\d+px \d+px \d+px \d+px$/);
  });

  it("preserves a non-zero column padding when the column has a colored background_style", () => {
    // The motivating bug: user_card_content drops column.padding when bg is non-default.
    // raw_card_content keeps it; we verify our projection passes that 12px through.
    const dsl = rawCardToDsl(loadFixture("button-behaviors.raw.json")) as AnyDsl;
    const colored = findElements(dsl, (el) =>
      el.tag === "column" && typeof el.background_style === "string" && el.background_style !== "default",
    );
    expect(colored.length).toBeGreaterThan(0);
    for (const col of colored) {
      expect(col.padding).toMatch(/^\d+px \d+px \d+px \d+px$/);
    }
  });
});

describe("img projection", () => {
  it("resolves imageID into img_key via the attachment table", () => {
    const dsl = rawCardToDsl(loadFixture("grid-images.raw.json")) as AnyDsl;
    const imgs = findElements(dsl, (el) => el.tag === "img");
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) {
      expect(img.img_key).toMatch(/^img_v3_/);
      expect(img).not.toHaveProperty("image_id");
    }
  });

  it("collapses width_height_pixels size_value into 'Wpx Hpx'", () => {
    const dsl = rawCardToDsl(loadFixture("grid-images.raw.json")) as AnyDsl;
    const sized = findElements(dsl, (el) => el.tag === "img" && typeof el.size === "string");
    expect(sized.length).toBeGreaterThan(0);
    for (const img of sized) {
      expect(img.size).toMatch(/^\d+px \d+px$/);
    }
  });
});

describe("markdown re-stitch", () => {
  it("renders <at id=all> for at_all child", () => {
    const dsl = rawCardToDsl(loadFixture("markdown-at.raw.json")) as AnyDsl;
    const md = findElements(dsl, (el) => el.tag === "markdown" && typeof el.content === "string" && /Hi/.test(el.content as string));
    expect(md.length).toBe(1);
    expect(md[0]?.content).toContain("<at id=all></at>");
  });

  it("collapses bold + color into inline markdown markers", () => {
    const dsl = rawCardToDsl(loadFixture("button-behaviors.raw.json")) as AnyDsl;
    const md = findElements(dsl, (el) =>
      el.tag === "markdown" && typeof el.content === "string" && (el.content as string).includes("**"),
    );
    expect(md.length).toBeGreaterThan(0);
  });

  it("preserves heading children as '# '/'## '/'### ' inline", () => {
    const dsl = rawCardToDsl(loadFixture("person-input.raw.json")) as AnyDsl;
    const md = findElements(dsl, (el) =>
      el.tag === "markdown" && typeof el.content === "string" && /(^|\n)##? /.test(el.content as string),
    );
    expect(md.length).toBeGreaterThan(0);
  });

  it("renders inline emoji children as :KEY: shortcodes", () => {
    // Regression: emoji segments used to fall through to the default case and
    // vanish (leaving a double space), so cards lost every emoji on round-trip.
    const dsl = rawCardToDsl(loadFixture("emoji.raw.json")) as AnyDsl;
    const contents = findElements(
      dsl,
      (el) => el.tag === "markdown" && typeof el.content === "string",
    ).map((el) => el.content as string);
    // Inline within a plain text run.
    expect(contents.some((c) => c.includes("hello :OK: world :Fire:"))).toBe(true);
    // Inline within a list item (routes through childToMarkdown, not the
    // inline-segment path).
    expect(contents.some((c) => c.includes(":Blush:"))).toBe(true);
  });

  it("renders inline person_v1 children as <person> tags (not dropped)", () => {
    // Regression: person_v1 / person as markdown children fell through to the
    // default case and vanished, so cards like「销售顾问 + @ + person chip」
    // lost the person chip on raw→DSL. Public syntax is the <person> tag.
    const dsl = rawCardToDsl(loadFixture("markdown-person.raw.json")) as AnyDsl;
    const contents = findElements(
      dsl,
      (el) => el.tag === "markdown" && typeof el.content === "string",
    ).map((el) => el.content as string);

    // Mixed with bold label + at mention.
    expect(contents.some((c) =>
      c.includes("**销售顾问**") &&
      c.includes("<at id=on_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa></at>") &&
      c.includes("<person id='on_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' show_name=true show_avatar=true style='normal'></person>")
    )).toBe(true);

    // Standalone person chips (style=normal and style=capsule) both survive.
    expect(contents.some((c) =>
      c.includes("style='normal'") && c.includes("style='capsule'")
    )).toBe(true);

    // Editor-only pillShaped must not leak.
    expect(JSON.stringify(dsl)).not.toContain("pillShaped");
    expect(JSON.stringify(dsl)).not.toContain("pill_shaped");
  });
});

describe("list re-stitch", () => {
  // Regression: a `list` child followed by a sibling plain_text used to close
  // with a single "\n". In Feishu markdown that is not enough to terminate the
  // block, so the following text ("历史问题TOP：") got parsed as a continuation
  // of the last bullet and rendered glued onto the same line. The list must
  // close with a blank line (\n\n) so the trailing paragraph stands alone.
  it("separates a list from a trailing paragraph with a blank line", () => {
    const dsl = rawCardToDsl(loadFixture("list-then-text.raw.json")) as AnyDsl;
    const md = findElements(
      dsl,
      (el) => el.tag === "markdown" && typeof el.content === "string" && (el.content as string).includes("历史问题TOP"),
    );
    expect(md.length).toBe(1);
    const content = md[0]?.content as string;
    // The bullet and the following bold paragraph must not share a line.
    expect(content).not.toContain("根因排查中\n**历史问题TOP");
    // They must be split by a blank line that closes the list block.
    expect(content).toContain("根因排查中\n\n**历史问题TOP");
  });
});

describe("code_block re-stitch", () => {
  function codeBlocks(dsl: AnyDsl): string[] {
    return findElements(
      dsl,
      (el) => el.tag === "markdown" && typeof el.content === "string" && (el.content as string).includes("```"),
    ).map((el) => el.content as string);
  }

  it("preserves line breaks across line-per-entry contents (regression: multi-line block collapsed to one line)", () => {
    const dsl = rawCardToDsl(loadFixture("code-block.raw.json")) as AnyDsl;
    const block = codeBlocks(dsl).find((c) => c.includes("line one"));
    expect(block).toBeDefined();
    // The three raw line entries must come back as three separate lines.
    expect(block).toContain("```plain_text\nline one\nline two\nline three\n```");
  });

  it("normalizes the single-entry-with-newlines encoding to no trailing blank line", () => {
    const dsl = rawCardToDsl(loadFixture("code-block.raw.json")) as AnyDsl;
    const block = codeBlocks(dsl).find((c) => c.includes("npm run build"));
    expect(block).toBeDefined();
    // The raw explicit trailing "\n" must not stack with our closing-fence
    // newline into a blank line before ```.
    expect(block).toContain("```bash\nnpm run build\n```");
    expect(block).not.toContain("npm run build\n\n```");
  });
});

describe("button projection", () => {
  it("projects raw button.actions:[{type:open_url}] to behaviors[]", () => {
    const dsl = rawCardToDsl(loadFixture("button-behaviors.raw.json")) as AnyDsl;
    const buttons = findElements(dsl, (el) => el.tag === "button");
    const withBehaviors = buttons.find((b) => Array.isArray(b.behaviors));
    expect(withBehaviors).toBeDefined();
    const behavior = (withBehaviors!.behaviors as unknown[])[0] as Record<string, unknown>;
    expect(behavior.type).toBe("open_url");
    expect(behavior.default_url).toMatch(/^https?:\/\//);
  });

  it("does not write empty pc_url / ios_url / android_url fields", () => {
    const dsl = rawCardToDsl(loadFixture("button-behaviors.raw.json")) as AnyDsl;
    const buttons = findElements(dsl, (el) => el.tag === "button");
    for (const b of buttons) {
      const behaviors = b.behaviors as unknown[] | undefined;
      if (!behaviors) continue;
      for (const beh of behaviors) {
        expect(beh).not.toHaveProperty("pc_url");
        expect(beh).not.toHaveProperty("ios_url");
        expect(beh).not.toHaveProperty("android_url");
      }
    }
  });
});

describe("header projection", () => {
  it("flattens raw card_header to top-level header without tag", () => {
    const dsl = rawCardToDsl(loadFixture("header-icon.raw.json")) as AnyDsl;
    expect(dsl.header).toBeDefined();
    expect(dsl.header).not.toHaveProperty("tag");
    expect(dsl.header?.template).toBeDefined();
  });

  it("projects raw udIcon to header.icon as standard_icon", () => {
    const dsl = rawCardToDsl(loadFixture("header-icon.raw.json")) as AnyDsl;
    const icon = dsl.header?.icon as Record<string, unknown> | undefined;
    expect(icon).toBeDefined();
    expect(icon?.tag).toBe("standard_icon");
    expect(typeof icon?.token).toBe("string");
  });
});

describe("chart projection", () => {
  it("preserves chart_spec internals as camelCase (vega is the engine)", () => {
    const dsl = rawCardToDsl(loadFixture("chart.raw.json")) as AnyDsl;
    const charts = findElements(dsl, (el) => el.tag === "chart");
    expect(charts.length).toBeGreaterThan(0);
    for (const chart of charts) {
      const spec = chart.chart_spec as Record<string, unknown> | undefined;
      expect(spec).toBeDefined();
      // canonical vega keys MUST stay camelCase
      const sampleKeys = Object.keys(spec!).join(",");
      // Any of these would be wrong:
      expect(sampleKeys).not.toContain("x_field");
      expect(sampleKeys).not.toContain("y_field");
      expect(sampleKeys).not.toContain("band_width");
      expect(sampleKeys).not.toContain("corner_radius");
    }
  });

  it("drops min_lib_version (raw editor metadata, public schema rejects it)", () => {
    const dsl = rawCardToDsl(loadFixture("chart.raw.json")) as AnyDsl;
    const charts = findElements(dsl, (el) => el.tag === "chart");
    for (const chart of charts) {
      expect(chart).not.toHaveProperty("min_lib_version");
      expect(chart).not.toHaveProperty("minLibVersion");
    }
  });
});

describe("table projection", () => {
  it("flattens columns to snake_case + width string (from widthValue echo)", () => {
    const dsl = rawCardToDsl(loadFixture("table.raw.json")) as AnyDsl;
    const [table] = findElements(dsl, (el) => el.tag === "table");
    expect(table).toBeDefined();
    const columns = table.columns as Array<Record<string, unknown>>;
    expect(columns.length).toBe(5);
    // camelCase raw fields must be projected to snake_case public fields
    const rank = columns[0]!;
    expect(rank.name).toBe("rank");
    expect(rank.display_name).toBe("排名");
    expect(rank.data_type).toBe("text");
    expect(rank.horizontal_align).toBe("center");
    expect(rank.width).toBe("80px"); // widthValue{pixels,80} -> "80px"
    expect(rank).not.toHaveProperty("displayName");
    expect(rank).not.toHaveProperty("widthValue");
    // builtin "auto" width keyword projected verbatim
    const brand = columns[1]!;
    expect(brand.width).toBe("auto");
    // number column keeps its format object
    const sales = columns[2]!;
    expect(sales.data_type).toBe("number");
    expect((sales.format as Record<string, unknown>).precision).toBe(1);
  });

  it("unwraps every cell from its { data } envelope to a bare value", () => {
    const dsl = rawCardToDsl(loadFixture("table.raw.json")) as AnyDsl;
    const [table] = findElements(dsl, (el) => el.tag === "table");
    const rows = table.rows as Array<Record<string, unknown>>;
    expect(rows.length).toBe(5);
    const first = rows[0]!;
    // text / number cells become bare strings (NOT { data: ... })
    expect(first.brand).toBe("比亚迪汽车");
    expect(first.rank).toBe("1");
    expect(first.sales).toBe("195.8");
    expect(first.brand).not.toHaveProperty?.("data");
    // options cell becomes the bare [{ text, color }] array
    expect(first.status).toEqual([{ color: "green", text: "新能源" }]);
  });

  it("projects header_style / row_height / page_size from raw echoes", () => {
    const dsl = rawCardToDsl(loadFixture("table.raw.json")) as AnyDsl;
    const [table] = findElements(dsl, (el) => el.tag === "table");
    const hs = table.header_style as Record<string, unknown>;
    expect(hs.background_style).toBe("grey");
    expect(hs.bold).toBe(true);
    expect(hs.text_align).toBe("center");
    expect(hs.lines).toBe(1); // linesValue{int_number,1} -> lines:1
    expect(hs).not.toHaveProperty("linesValue");
    expect(hs).not.toHaveProperty("platformTextSize");
    expect(table.row_height).toBe("middle"); // rowHeightValue.value
    expect(table.page_size).toBe(5);
  });

  it("no camelCase / {data} leaks anywhere under the projected table", () => {
    const dsl = rawCardToDsl(loadFixture("table.raw.json")) as AnyDsl;
    const [table] = findElements(dsl, (el) => el.tag === "table");
    const leaks = collectKeys(table, (k) =>
      k === "widthValue" || k === "displayName" || k === "dataType" ||
      k === "horizontalAlign" || k === "rowHeightValue" || k === "pageSize" ||
      k === "freezeFirstColumn" || k === "linesValue",
    );
    expect(leaks).toEqual([]);
  });
});

describe("person projection", () => {
  it("projects userID to user_id and drops pillShaped", () => {
    const dsl = rawCardToDsl(loadFixture("person-input.raw.json")) as AnyDsl;
    const persons = findElements(dsl, (el) => el.tag === "person");
    expect(persons.length).toBeGreaterThan(0);
    for (const p of persons) {
      expect(p.user_id).toMatch(/^ou_/);
      expect(p).not.toHaveProperty("pill_shaped");
      expect(p).not.toHaveProperty("pillShaped");
    }
  });
});

/**
 * Regression for the on-device PATCH failures (code 200621) on cards carrying
 * the editor's person components. The fixture is a real raw_card_content with
 * both a single `person_v1` and a `person_list`. Two distinct bugs:
 *
 *   1. The editor tags a single user `person_v1`, not the public `person`, so
 *      the unconverted tag leaked into the DSL -> "not support tag: person_v1".
 *   2. person_list wasn't handled at all: persons[i] kept its editor-only
 *      `type:'user'` -> "unknown property: type, path: ... persons -> [0]";
 *      and top-level style/mode/count + a sibling fallback node leaked too.
 */
describe("person_v1 / person_list projection (real card regression)", () => {
  it("renames person_v1 to the public person tag (no person_v1 leaks)", () => {
    const dsl = rawCardToDsl(loadFixture("person-list.raw.json")) as AnyDsl;
    expect(JSON.stringify(dsl)).not.toContain("person_v1");
    const persons = findElements(dsl, (el) => el.tag === "person");
    expect(persons.length).toBeGreaterThan(0);
    for (const p of persons) {
      expect(p.user_id).toMatch(/^ou_/);
      expect(p).not.toHaveProperty("pillShaped");
      expect(p).not.toHaveProperty("pill_shaped");
      // margin {top,..} pixels projected to an "Npx ..." box string.
      if ("margin" in p) expect(typeof p.margin).toBe("string");
    }
  });

  it("projects person_list and strips schema-rejected fields", () => {
    const dsl = rawCardToDsl(loadFixture("person-list.raw.json")) as AnyDsl;
    const lists = findElements(dsl, (el) => el.tag === "person_list");
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      // persons[i] must be { id } only — no editor-only `type`.
      expect(Array.isArray(list.persons)).toBe(true);
      for (const person of list.persons as Record<string, unknown>[]) {
        expect(person.id).toMatch(/^ou_/);
        expect(person).not.toHaveProperty("type");
        expect(Object.keys(person)).toEqual(["id"]);
      }
      // top-level editor-only fields dropped.
      expect(list).not.toHaveProperty("style");
      expect(list).not.toHaveProperty("mode");
      expect(list).not.toHaveProperty("count");
      expect(list).not.toHaveProperty("fallback");
    }
  });

  it("emits no person_list field the public schema rejects", () => {
    const dsl = rawCardToDsl(loadFixture("person-list.raw.json")) as AnyDsl;
    // `type` only ever appears as a person identity field in raw; the public
    // person_list has no `type` anywhere in its subtree.
    const lists = findElements(dsl, (el) => el.tag === "person_list");
    for (const list of lists) {
      expect(collectKeys(list, (k) => k === "type" || k === "mode" || k === "count")).toEqual([]);
    }
  });
});

describe("input projection", () => {
  it("strips editor-only fields (actions, autoResize, showCount, showIcon, disabled:false)", () => {
    const dsl = rawCardToDsl(loadFixture("person-input.raw.json")) as AnyDsl;
    const inputs = findElements(dsl, (el) => el.tag === "input");
    expect(inputs.length).toBeGreaterThan(0);
    for (const inp of inputs) {
      expect(inp).not.toHaveProperty("actions");
      expect(inp).not.toHaveProperty("auto_resize");
      expect(inp).not.toHaveProperty("show_count");
      expect(inp).not.toHaveProperty("show_icon");
      expect(inp).not.toHaveProperty("disabled");
      expect(inp).not.toHaveProperty("required"); // false default is dropped
    }
  });
});

/**
 * Offline regression for the two bugs a live im.message.get payload exposed
 * (live-bare-body fixture). The editor-saved fixtures above all wrap body as
 * { id, tag, property:{ elements } } and carry schema:"2.0" in json_card; this
 * live card does neither, which previously produced an empty body and a
 * missing schema. The fixture lets us guard both without API credentials.
 */
describe("live bare-body envelope (offline regression)", () => {
  it("does not drop the body when it has no `property` wrapper", () => {
    const dsl = rawCardToDsl(loadFixture("live-bare-body.raw.json")) as AnyDsl;
    expect(Array.isArray(dsl.body?.elements)).toBe(true);
    expect((dsl.body!.elements as unknown[]).length).toBe(3);
  });

  it("flattens v1 `div` section blocks to top-level markdown (schema 2.0 has no div)", () => {
    // Feishu rejects a div: "type of element is not supported tag: markdown,
    // path: ...div->text". The live payload wraps text in a v1 div; we promote
    // the single text child to a top-level markdown element.
    const dsl = rawCardToDsl(loadFixture("live-bare-body.raw.json")) as AnyDsl;
    const tags = (dsl.body!.elements as Array<Record<string, unknown>>).map((e) => e.tag);
    expect(tags).toEqual(["markdown", "img", "markdown"]);
    expect(findElements(dsl, (el) => el.tag === "div")).toEqual([]);
  });

  it("emits schema \"2.0\" even when the raw json_card omits it", () => {
    const dsl = rawCardToDsl(loadFixture("live-bare-body.raw.json")) as AnyDsl;
    expect(dsl.schema).toBe("2.0");
  });

  it("resolves img imageID -> img_key and drops v1-only custom_width", () => {
    // custom_width has no slot in v2 img sizing; Feishu rejects it next to
    // scale_type ("img mode is not supported" / "img size is not allowed").
    const dsl = rawCardToDsl(loadFixture("live-bare-body.raw.json")) as AnyDsl;
    const imgs = findElements(dsl, (el) => el.tag === "img");
    expect(imgs.length).toBe(1);
    expect(imgs[0]!.img_key).toMatch(/^img_/);
    expect(imgs[0]).not.toHaveProperty("image_id");
    expect(imgs[0]).not.toHaveProperty("custom_width");
  });

  it("does not leak v1-only i18n_* mirrors or `lines` that schema 2.0 rejects", () => {
    // Feishu rejected real sends over these: the v2 lint flags `i18n_elements`
    // and the API returns 200621 "unknown property: lines". Both are editor
    // mirrors raw emits on every text/img/header node; none have a 2.0 slot.
    const dsl = rawCardToDsl(loadFixture("live-bare-body.raw.json")) as AnyDsl;
    const leaks = collectKeys(dsl, (k) => k.startsWith("i18n") || k === "lines");
    expect(leaks).toEqual([]);
  });

  it("keeps bold markers off whitespace so `**` doesn't render literally", () => {
    // Raw stores bold segments with trailing spaces ("1. ", "· "). Wrapping
    // them verbatim yields `**1. **`, which CommonMark refuses to bold — the
    // asterisks print literally (the bug the user saw). The fix moves the
    // space outside: `**1.** `. Assert the concrete before/after substrings.
    const dsl = rawCardToDsl(loadFixture("live-bare-body.raw.json")) as AnyDsl;
    const md = findElements(dsl, (el) => el.tag === "markdown")
      .map((el) => el.content as string)
      .join("\n");
    // The editor separates these labels with a U+2004 space, not ASCII " ".
    const SP = "\u2004";
    // Fixed: space sits OUTSIDE the closing marker -> renders bold.
    expect(md).toContain(`**1.**${SP}`);
    expect(md).toContain(`**2.**${SP}`);
    expect(md).toContain(`**·**${SP}`);
    // Broken: space hugged the closing `**` -> CommonMark prints literal stars.
    expect(md).not.toContain(`**1.${SP}**`);
    expect(md).not.toContain(`**2.${SP}**`);
    expect(md).not.toContain(`**·${SP}**`);
  });

  it("matches the archived expected DSL exactly", () => {
    const dsl = rawCardToDsl(loadFixture("live-bare-body.raw.json"));
    const expected = loadFixture("live-bare-body.expected.json");
    expect(dsl).toEqual(expected);
  });
});

/**
 * Class-wide guard: no fixture, regardless of element mix, may leak a v1-only
 * field schema 2.0 rejects. This catches the leak family the live agent tripped
 * over (i18n_elements, then lines) on any future fixture, not just the one card.
 */
describe("no v1-only field leaks (all fixtures)", () => {
  const RAW_FIXTURES = [
    "button-behaviors.raw.json",
    "chart.raw.json",
    "code-block.raw.json",
    "grid-images.raw.json",
    "header-icon.raw.json",
    "live-bare-body.raw.json",
    "markdown-at.raw.json",
    "markdown-person.raw.json",
    "person-input.raw.json",
  ];
  for (const name of RAW_FIXTURES) {
    it(`${name} emits no i18n_* / lines residue`, () => {
      const dsl = rawCardToDsl(loadFixture(name));
      const leaks = collectKeys(dsl, (k) => k.startsWith("i18n") || k === "lines");
      expect(leaks).toEqual([]);
    });
  }
});

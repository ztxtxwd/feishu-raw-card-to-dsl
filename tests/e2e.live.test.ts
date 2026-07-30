/**
 * Live end-to-end test against the real Feishu API.
 *
 * It proves the converter is faithful by cross-checking against Feishu's OWN
 * rendering of the same card. For one message we fetch both content forms:
 *
 *   - user_card_content : Feishu's lossy-but-authoritative public render. The
 *                         markdown `content` strings here are the ground truth
 *                         for what the card actually says.
 *   - raw_card_content  : the editor-internal envelope this library converts.
 *
 * We then run rawCardToDsl(raw) and assert THREE independent things:
 *
 *   1. Content fidelity (oracle = user_card_content): element for element, our
 *      conversion reproduces the same text content / img_key / header Feishu
 *      itself rendered. Catches dropped or mangled content.
 *
 *   2. No v1-only residue (no oracle needed): the converted DSL must contain
 *      ZERO fields schema 2.0 rejects (i18n_* mirrors, `lines`, ...). This is
 *      the gap that let i18n_elements / lines ship to production — the
 *      user_card_content oracle can't catch it, because Feishu's lossy render
 *      never carries those fields in the first place, so comparing against it
 *      only ever checks the fields BOTH sides happen to have.
 *
 *   3. Feishu accepts it (the real judge, opt-in): when E2E_SEND_CHAT_ID is
 *      set, we actually POST the converted DSL via im.message.create. A 2.0
 *      lint pass + Feishu accepting the card is the only ground truth for
 *      "this DSL is sendable". Off by default so the suite doesn't spam a chat.
 *
 * The test is GATED on credentials + message id: it self-skips when
 * FEISHU_APP_ID / FEISHU_APP_SECRET / E2E_MESSAGE_ID are absent (e.g. CI
 * without secrets), so `pnpm test` stays green offline. Credentials are read
 * from the environment or, as a convenience for local runs, from a .env file
 * at the repo root.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { isRawCardEnvelope, rawCardToDsl } from "../src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://open.feishu.cn/open-apis";

// Required for live runs. No hardcoded message id — set E2E_MESSAGE_ID=om_... locally.
const MESSAGE_ID = process.env.E2E_MESSAGE_ID;

/** Read FEISHU_* from process.env, falling back to a repo-root .env file. */
function loadCreds(): { appId?: string; appSecret?: string } {
  let appId = process.env.FEISHU_APP_ID;
  let appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    try {
      const env = readFileSync(resolve(REPO_ROOT, ".env"), "utf8");
      for (const line of env.split(/\r?\n/)) {
        const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        if (m[1] === "FEISHU_APP_ID" && !appId) appId = m[2];
        if (m[1] === "FEISHU_APP_SECRET" && !appSecret) appSecret = m[2];
      }
    } catch {
      /* no .env file — that's fine, we'll just skip */
    }
  }
  return { appId, appSecret };
}

const { appId, appSecret } = loadCreds();
const hasCreds = Boolean(appId && appSecret && MESSAGE_ID);

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(BASE + path, init);
  return res.json();
}

async function getToken(): Promise<string> {
  const json = await api("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (json.code !== 0) throw new Error(`token failed: ${JSON.stringify(json)}`);
  return json.tenant_access_token as string;
}

/** Fetch one message in a given content form; returns parsed body.content. */
async function getCardContent(token: string, mode: string): Promise<any> {
  const json = await api(
    `/im/v1/messages/${MESSAGE_ID}?card_msg_content_type=${mode}&user_id_type=open_id`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (json.code !== 0) throw new Error(`message.get(${mode}) failed: ${JSON.stringify(json)}`);
  const content = json.data?.items?.[0]?.body?.content;
  if (typeof content !== "string") throw new Error(`no string body.content for ${mode}`);
  return JSON.parse(content);
}

/** POST a converted DSL as an interactive card; returns Feishu's raw response. */
async function sendCard(token: string, chatId: string, dsl: unknown): Promise<any> {
  return api("/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: "interactive",
      content: JSON.stringify(dsl),
    }),
  });
}

/**
 * Collect every object key in a tree that schema 2.0 rejects. This is the
 * oracle-free check: instead of comparing against Feishu's lossy render (which
 * never has these fields to begin with), we assert our output is free of the
 * v1-only residue the public schema bounces — i18n_* localization mirrors and
 * the editor's `lines` count. Returns "path.key" strings for any hit.
 */
function v1OnlyLeaks(dsl: unknown): string[] {
  const out: string[] = [];
  function walk(v: unknown, path: string) {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k.startsWith("i18n") || k === "lines") out.push(`${path}.${k}`);
        walk(val, `${path}.${k}`);
      }
    }
  }
  walk(dsl, "root");
  return out;
}

/**
 * Reduce a card (either the user_card_content shape or our converted DSL) to a
 * comparable list of leaf signatures. Both schemas nest interactive elements,
 * but for this card we compare the top-level div/img stream + header.
 */
interface Leaf {
  kind: string;
  content?: string;
  img_key?: string;
}

function uccLeaves(card: any): Leaf[] {
  // user_card_content is schema 1.0: top-level `elements`, div.text.content.
  const els: any[] = Array.isArray(card.elements) ? card.elements : [];
  return els.map((e) => leafOf(e));
}

function dslLeaves(dsl: any): Leaf[] {
  // our DSL is schema 2.0: body.elements.
  const els: any[] = Array.isArray(dsl.body?.elements) ? dsl.body.elements : [];
  return els.map((e) => leafOf(e));
}

/**
 * Normalize an element to a schema-version-agnostic text/image leaf. v1
 * (user_card_content) renders a text block as { tag:"div", text:{ content } };
 * v2 (our DSL) renders the same content as { tag:"markdown", content }. Both
 * collapse to { kind:"text", content } so the oracle compares CONTENT, not the
 * schema-version-specific element name.
 */
/**
 * Canonicalize bold-emphasis whitespace so the oracle compares CONTENT, not
 * CommonMark conformance. Feishu's own user_card_content stores `**1. **`
 * (space hugging the closing `**`), which renders literal asterisks; our
 * converter deliberately rewrites that to the valid `**1.** `. Both mean the
 * same thing, so we collapse `**<text><ws>**` -> `**<text>**<ws>` (and the
 * leading-space mirror) on both sides before comparing. This keeps the oracle
 * honest about text fidelity without flagging the very fix under test.
 */
function normalizeEmphasis(s: string | undefined): string | undefined {
  if (typeof s !== "string") return s;
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur
      .replace(/\*\*(\s+)([^*]*?)\*\*/g, "$1**$2**") // leading space outside
      .replace(/\*\*([^*]*?)(\s+)\*\*/g, "**$1**$2"); // trailing space outside
  } while (cur !== prev);
  return cur;
}

function leafOf(e: any): Leaf {
  if (e?.tag === "div") return { kind: "text", content: normalizeEmphasis(e.text?.content) };
  if (e?.tag === "markdown") return { kind: "text", content: normalizeEmphasis(e.content) };
  if (e?.tag === "img") return { kind: "img", img_key: e.img_key };
  return { kind: String(e?.tag) };
}

// Optional: when set, the suite actually sends the converted DSL to this chat
// and lets Feishu be the judge of whether it's a valid 2.0 card.
const SEND_CHAT_ID = process.env.E2E_SEND_CHAT_ID;

describe.skipIf(!hasCreds)("live e2e: raw_card_content -> DSL matches user_card_content", () => {
  let token: string;
  let userCard: any;
  let rawEnvelope: any;
  let dsl: any;

  beforeAll(async () => {
    token = await getToken();
    // Fetch both forms of the SAME message.
    userCard = await getCardContent(token, "user_card_content");
    rawEnvelope = await getCardContent(token, "raw_card_content");
    dsl = rawCardToDsl(rawEnvelope);
  }, 30_000);

  it("raw_card_content really is the editor envelope", () => {
    expect(isRawCardEnvelope(rawEnvelope)).toBe(true);
  });

  it("converts to a well-formed 2.0 DSL with a non-empty body", () => {
    expect(dsl.schema).toBe("2.0");
    expect(dsl.config).toEqual({ update_multi: true });
    expect(Array.isArray(dsl.body?.elements)).toBe(true);
    // Regression guard for the empty-body bug: body must carry every element.
    expect(dsl.body.elements.length).toBeGreaterThan(0);
  });

  it("reproduces the same element stream Feishu itself rendered", () => {
    const expected = uccLeaves(userCard);
    const actual = dslLeaves(dsl);
    // Same number of leaves, same kinds, in the same order (schema-agnostic).
    expect(actual.map((l) => l.kind)).toEqual(expected.map((l) => l.kind));
    // And each leaf's payload (text content / img_key) matches exactly.
    expect(actual).toEqual(expected);
  });

  it("reproduces the header verbatim", () => {
    expect(dsl.header?.title?.content).toBe(userCard.header?.title?.content);
    expect(dsl.header?.template).toBe(userCard.header?.template);
  });

  it("emits no v1-only fields that schema 2.0 rejects", () => {
    // The oracle above can't catch this: user_card_content is a lossy render
    // that never carries i18n_* / lines, so comparing against it only checks
    // the fields both sides share. This asserts directly against the 2.0 spec
    // instead. It's exactly what shipped to prod: i18n_elements + lines.
    const leaks = v1OnlyLeaks(dsl);
    expect(leaks).toEqual([]);
  });

  // The ultimate judge: does Feishu itself accept the converted DSL? Off by
  // default (would post into a real chat); set E2E_SEND_CHAT_ID=oc_... to run.
  it.skipIf(!SEND_CHAT_ID)("Feishu accepts the converted DSL on im.message.create", async () => {
    const res = await sendCard(token, SEND_CHAT_ID!, dsl);
    // code 0 == accepted. Any lint/parse rejection (e.g. 230099 / 200621)
    // surfaces here as a non-zero code with the offending field path.
    expect(res.code, `Feishu rejected the card: ${JSON.stringify(res)}`).toBe(0);
    expect(res.data?.message_id).toBeTruthy();
  }, 30_000);
});

// Live end-to-end test of rawCardToDsl against the real Feishu API.
//
// Usage (bash):
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=yyy \
//     node scripts/live-test.mjs om_<message_id> oc_<chat_id>
//
// Steps:
//   1. tenant_access_token (internal app)
//   2. im.message.get with card_msg_content_type=raw_card_content  -> raw envelope
//   3. rawCardToDsl(envelope)                                      -> public 2.0 DSL
//   4. im.message.create (msg_type=interactive)                    -> post into the group
//
// Zero extra deps: uses global fetch (Node >=18).

import { rawCardToDsl, isRawCardEnvelope } from "../dist/index.js";

const BASE = "https://open.feishu.cn/open-apis";

const APP_ID = process.env.FEISHU_APP_ID;
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const MESSAGE_ID = process.argv[2];
const CHAT_ID = process.argv[3];

function die(msg) {
  console.error("ERROR:", msg);
  process.exit(1);
}

if (!APP_ID || !APP_SECRET) die("FEISHU_APP_ID / FEISHU_APP_SECRET env vars required");
if (!MESSAGE_ID) die("arg1 message_id (om_...) required");
if (!CHAT_ID) die("arg2 chat_id (oc_...) required");

async function api(path, init) {
  const res = await fetch(BASE + path, init);
  const json = await res.json().catch(() => ({}));
  return { http: res.status, json };
}

async function getToken() {
  const { json } = await api("/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  if (json.code !== 0) die(`token failed: ${JSON.stringify(json)}`);
  return json.tenant_access_token;
}

async function main() {
  const token = await getToken();
  const auth = { Authorization: `Bearer ${token}` };

  // 1. fetch the source card as raw envelope
  const { json: got } = await api(
    `/im/v1/messages/${MESSAGE_ID}?card_msg_content_type=raw_card_content`,
    { headers: auth }
  );
  if (got.code !== 0) die(`message.get failed: ${JSON.stringify(got)}`);

  const item = got.data?.items?.[0];
  const rawContent = item?.body?.content;
  if (typeof rawContent !== "string") die(`no string body.content; msg_type=${item?.msg_type}`);

  const envelope = JSON.parse(rawContent);
  console.log("--- source msg_type:", item.msg_type, "isRawCardEnvelope:", isRawCardEnvelope(envelope));

  if (!isRawCardEnvelope(envelope)) {
    console.log("NOT a raw card envelope. Parsed content:");
    console.log(JSON.stringify(envelope, null, 2));
    die("source is not raw_card_content form; cannot test conversion");
  }

  // 2. convert
  const dsl = rawCardToDsl(envelope);
  console.log("--- converted DSL ---");
  console.log(JSON.stringify(dsl, null, 2));

  // 3. send into the experiment group
  const { json: sent } = await api("/im/v1/messages?receive_id_type=chat_id", {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      receive_id: CHAT_ID,
      msg_type: "interactive",
      content: JSON.stringify(dsl),
    }),
  });

  if (sent.code !== 0) {
    console.error("--- SEND FAILED ---");
    console.error(JSON.stringify(sent, null, 2));
    die("im.message.create rejected the converted DSL (see error above)");
  }

  console.log("--- SENT OK --- message_id:", sent.data?.message_id);
}

main().catch((e) => die(e?.stack || String(e)));

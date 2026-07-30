/**
 * Convert the editor-internal "raw_card_content" payload returned by
 * `im.message.get?card_msg_content_type=raw_card_content` into the public
 * JSON Schema 2.0 DSL we author and send.
 *
 * The raw payload differs from the public DSL in several ways:
 *   1. Every node is wrapped as { id, tag, property: { ...real fields... } }.
 *   2. Field names are camelCase (textAlign, backgroundStyle, imageID, ...).
 *   3. Box fields (padding/margin) are objects { bottom:{type,value}, ... }
 *      instead of "Tpx Rpx Bpx Lpx" strings; scalar pixels (corner_radius,
 *      icon size) are similarly objectified.
 *   4. Images carry imageID (numeric) which indexes into a separate
 *      json_attachment.images table to recover the real img_key.
 *   5. Markdown is split into per-segment children (plain_text / link / br /
 *      at_all / person_v1 / text_tag / code_span / ...) under a wrapper
 *      element with originTag:'markdown'; we re-stitch them back into a
 *      single content string with inline markers.
 *   6. Header is wrapped as `tag: 'card_header'` and its icon shows up as a
 *      sibling `udIcon` wrapper around an inner `ud_icon` element.
 *   7. Editor mirrors the same value twice — a coarse enum (width:'auto')
 *      alongside a precise echo (widthValue:{type:'pixels',value:72}). We
 *      project the precise echo back onto the enum when it disagrees.
 *   8. Most nodes carry editor defaults (disabled:false, vertical_align:
 *      'top', flex_mode:'none', background_style:'default') that the public
 *      DSL omits. We strip them.
 *   9. The whole thing is double-stringified into body.content as
 *      { json_card: "<stringified card>", json_attachment: { images, at_users? } }.
 *
 * Why we do this: the documented user_card_content path drops fields whose
 * values match a server-side default (notably `column.padding` on a column
 * with `background_style`), which silently breaks layouts on round-trip.
 * The raw payload preserves them. We project raw -> public DSL on the read
 * path so downstream code (patch_lark_card, archives, the model's mental
 * model) keeps working against the only format that has a public spec.
 *
 * No public spec exists for the raw payload. The mapping below is sample-
 * driven, derived from diffing rawCardToDsl(raw) against archived public DSL
 * for ~250 cards we previously sent. When the converter encounters something
 * it does not recognize, it keeps the original key/value (snake-cased) so
 * downstream sees an unknown field rather than silently losing data.
 */

type AttachmentImageMap = Record<string, { origin_key?: string }>;
type AttachmentAtUserMap = Record<string, { user_id?: string; mention_key?: string }>;

interface RawEnvelope {
  json_card?: string;
  json_attachment?: { images?: AttachmentImageMap; at_users?: AttachmentAtUserMap };
  card_schema?: number;
}

export function isRawCardEnvelope(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.json_card === "string" && typeof v.card_schema === "number";
}

export function rawCardToDsl(envelope: unknown): unknown {
  if (!isRawCardEnvelope(envelope)) return envelope;
  const env = envelope as RawEnvelope;
  let inner: unknown;
  try {
    inner = JSON.parse(env.json_card ?? "");
  } catch {
    return envelope;
  }
  const ctx: Ctx = {
    images: env.json_attachment?.images ?? {},
    atUsers: env.json_attachment?.at_users ?? {},
  };
  return convertRoot(inner, ctx);
}

interface Ctx {
  images: AttachmentImageMap;
  atUsers: AttachmentAtUserMap;
}

/* ------------------------------------------------------------------ *
 * Defaults / known editor-only fields
 * ------------------------------------------------------------------ */

/**
 * Confirmed editor residue by diffing the raw payload against ~250 archived
 * public-DSL cards we authored. These have no slot in the public schema,
 * either because they're editor metadata or because they duplicate a sibling
 * enum (the precise *_value echo is reconciled separately).
 */
const RAW_ONLY_FIELDS = new Set<string>([
  "new_body",
  "source",
  // Editor line-count mirror on markdown/plain_text. Schema 2.0 has no `lines`
  // field; Feishu rejects it with code 200621 ("unknown property, property:
  // lines"). Raw emits it on every text node (lines:0), so drop it everywhere.
  "lines",
]);

/**
 * The editor mirrors every localizable field into a parallel empty i18n table
 * (i18nElements / i18nContent / i18nImageID / i18nTextTagList -> i18n_*). These
 * are v1-only: schema 2.0 puts content in body.elements and titles in
 * header.title, and the v2 lint rejects any `i18n_*` key. They're always empty
 * on cards authored without translations, so we drop the whole family.
 */
function isI18nMirror(key: string): boolean {
  return key.startsWith("i18n");
}

/**
 * Tag-scoped raw-only fields. The remaining img fields (preview, transparent,
 * size, corner_radius, scale_type) are kept; archive samples show authors
 * write them explicitly.
 *
 * `custom_width` (a numeric v1 width) has no slot in schema 2.0 img sizing —
 * v2 sizes via `size` (+ `scale_type`), and Feishu rejects custom_width
 * alongside either ("img size is not allowed" / the misleading "img mode is
 * not supported"). Editor-saved v2 cards never emit it; live im.message.get
 * payloads still carry the v1 field, so we drop it here.
 */
const IMG_RAW_ONLY_FIELDS = new Set<string>([
  "compact_width",
  "custom_width",
  "mode",
]);

/**
 * Per-tag default values that the public DSL routinely omits even though raw
 * always emits them. Confirmed by diffing rawCardToDsl(raw) against archives
 * we authored: cards either left these out entirely or wrote a different
 * value, so dropping the noisy defaults closes the gap. Other ostensibly
 * "default-looking" fields (direction, vertical_align, horizontal_align)
 * are kept verbatim — many of our archived cards write them explicitly even
 * when they match the editor default, and dropping them would produce
 * spurious "missing field" diffs.
 */
/**
 * Per-tag editor-default drops. We only list fields the public DSL definitely
 * never reads back. Layout fields (text_align / vertical_align / flex_mode /
 * background_style) look defaultable but archive convention varies — some
 * card vintages write the default explicitly. We pass them through verbatim
 * because, from a patch-link perspective, an extra field on the projected
 * working copy is harmless (Read sees more, find/replace doesn't fail),
 * whereas a missing field that the archived snapshot expected would break
 * downstream comparisons or surprise a model that authored against the
 * complete shape.
 *
 * collapsible_panel.header carries raw editor-only layout fields (position,
 * width, vertical_align) the archived public DSL never writes; those are
 * dropped under their explicit owner tag below.
 */
const TAG_DEFAULT_DROPS: Record<string, Record<string, unknown>> = {
  column: {
    disabled: false,
  },
  column_set: {
    disabled: false,
    horizontal_spacing: "default",
  },
  button: {
    disabled: false,
  },
  interactive_container: {
    disabled: false,
    required: false,
    has_border: false,
    height: "auto",
  },
};

/**
 * Maps a `*_value` echo field to the sibling enum it should reconcile with.
 * Both are dropped after reconciliation; the public DSL keeps only the enum
 * field with a string-pixel value when the echo disagreed with the enum.
 */
const VALUE_ECHO_TARGETS: Record<string, string> = {
  horizontal_spacing_value: "horizontal_spacing",
  vertical_spacing_value: "vertical_spacing",
  width_value: "width",
  height_value: "height",
  corner_radius_value: "corner_radius",
  size_value: "size",
};

/* ------------------------------------------------------------------ *
 * Entry points
 * ------------------------------------------------------------------ */

function convertRoot(root: unknown, ctx: Ctx): unknown {
  if (!isRecord(root)) return root;
  const out: Record<string, unknown> = {};
  // Public DSL must declare schema "2.0". Editor-saved cards echo it in the raw
  // json_card, but some live im.message.get payloads omit it entirely; the
  // cardkit send path rejects a card with no schema, so we always emit "2.0"
  // (this converter only ever targets the 2.0 DSL).
  out.schema = typeof root.schema === "string" ? root.schema : "2.0";
  out.config = convertConfig(isRecord(root.config) ? root.config : {});
  if (isRecord(root.body)) out.body = convertBody(root.body, ctx);
  if (isRecord(root.header)) out.header = convertHeader(root.header, ctx);
  return out;
}

/**
 * Public DSL config the cardkit send path expects: { update_multi: true }.
 * Raw carries editor-only flags (convertVersion / enableForwardInteraction /
 * streamingMode) that the public schema doesn't read; we drop them and
 * synthesize update_multi:true, which is the invariant the cardkit entity
 * create/update path requires (see card-actions.ts:194-198 lint rule).
 *
 * Some archived cards happen to record the editor flags instead of
 * update_multi — that's a quirk of how those cards were saved, not what the
 * public DSL means. The projection above matches what we'd send today.
 */
function convertConfig(_node: Record<string, unknown>): unknown {
  return { update_multi: true };
}

function convertHeader(node: Record<string, unknown>, ctx: Ctx): unknown {
  const property = isRecord(node.property) ? node.property : {};
  const out = convertProperty(property, "header", ctx) as Record<string, unknown>;
  // Raw stashes the header icon as `udIcon` (an editor-only wrapper around
  // a standard_icon). Projection happens via convertField; here we just
  // verify the rename landed correctly.
  return out;
}

function convertBody(node: Record<string, unknown>, ctx: Ctx): unknown {
  // Raw body comes in two shapes:
  //   1. wrapped:   { id, tag, property: { elements, ... } }  (editor-saved cards)
  //   2. bare:      { elements, ... }                          (some live im.message.get payloads)
  // The bare form has no `property` envelope; fall back to the node itself so
  // we don't silently drop the entire body.
  const property = isRecord(node.property) ? node.property : node;
  return convertProperty(property, "body", ctx);
}

function unwrap(node: Record<string, unknown>, ctx: Ctx): unknown {
  const tag = typeof node.tag === "string" ? node.tag : undefined;
  const property = isRecord(node.property) ? node.property : {};

  if (tag === "markdown") return rebuildMarkdown(property, ctx);

  // plain_text leaf used inside title/subtitle/alt/hover_tips/button.text/
  // div.text/etc. The public DSL keeps only { tag:'plain_text', content };
  // everything else is editor metadata for layout. (Block-level text in raw is
  // always wrapped in a `markdown` node — a bare plain_text never sits directly
  // in elements[], so there's no block-level plain_text case to handle here.)
  if (tag === "plain_text") {
    const content = typeof property.content === "string" ? property.content : "";
    return { tag: "plain_text", content };
  }

  // standard_icon used inside button / header / column action.
  // Public shape: { tag:'standard_icon', token, color?, size? }.
  // Raw also ships imageID (fallback render asset, drop), horizontalPadding
  // (editor-only), and a precise widthValue+heightValue pair the public DSL
  // collapses into a single "Wpx Hpx" size string.
  if (tag === "standard_icon") {
    const out: Record<string, unknown> = { tag: "standard_icon" };
    if (typeof property.token === "string") out.token = property.token;
    if (typeof property.color === "string") out.color = property.color;
    const widthPx = isPixelScalar(property.widthValue)
      ? pixelOf(property.widthValue as Record<string, unknown>)
      : undefined;
    const heightPx = isPixelScalar(property.heightValue)
      ? pixelOf(property.heightValue as Record<string, unknown>)
      : undefined;
    if (widthPx !== undefined && heightPx !== undefined) {
      out.size = `${widthPx}px ${heightPx}px`;
    } else if (isRecord(property.size) && hasSide(property.size)) out.size = formatBox(property.size);
    else if (isPixelScalar(property.size)) out.size = `${pixelOf(property.size as Record<string, unknown>)}px`;
    else if (typeof property.size === "string") out.size = property.size;
    return out;
  }

  // ud_icon is the editor's wrapper for header icons. The public DSL
  // reads it back as a standard_icon — only the token survives.
  if (tag === "ud_icon") {
    const token = typeof property.token === "string" ? property.token : undefined;
    const out: Record<string, unknown> = { tag: "standard_icon" };
    if (token) out.token = token;
    return out;
  }

  // chart tag. Public shape: { tag:'chart', color_theme?, preview?, chart_spec }.
  // chart_spec is a vchart/vega specification whose field names (xField,
  // yField, bandWidth, cornerRadius, ...) MUST stay camelCase — vega is the
  // chart engine, not flexible cardspec. Raw also carries minLibVersion which
  // the public schema rejects.
  if (tag === "chart") {
    const out: Record<string, unknown> = { tag: "chart" };
    if (typeof property.colorTheme === "string") out.color_theme = property.colorTheme;
    if (typeof property.preview === "boolean") out.preview = property.preview;
    if (property.chartSpec !== undefined) out.chart_spec = property.chartSpec;
    // minLibVersion / preview defaults / etc. drop intentionally.
    return out;
  }

  // table tag (top-level data table; NOT the markdown-embedded pipe table at
  // childToMarkdown). Public shape: { tag:'table', columns, rows, header_style?,
  // row_height?, page_size?, freeze_first_column? }. Raw differs three ways the
  // generic path can't fix, which is why it must be handled explicitly:
  //   1. Columns are camelCase (dataType/displayName/horizontalAlign) and width
  //      lives in a widthValue:{type,value} echo (pixels → "Npx"; the builtin
  //      "auto" keyword → "auto"). Public DSL flattens to snake_case + width string.
  //   2. Every cell is wrapped { data: <value> }; the public DSL holds the bare
  //      value. For a `markdown` cell the value is a {tag:'markdown'} element that
  //      we re-stitch to a content string (same as block markdown elsewhere);
  //      text/number cells are plain strings, options cells are [{text,color}].
  //   3. header_style mirrors editor-only echoes (platformTextSize, linesValue);
  //      we keep the public fields and project linesValue → lines. row_height /
  //      page_size / freeze_first_column come from rowHeightValue / pageSize /
  //      freezeFirstColumn.
  if (tag === "table") {
    const out: Record<string, unknown> = { tag: "table" };

    const rawColumns = Array.isArray(property.columns) ? property.columns : [];
    out.columns = rawColumns.map((col) => {
      if (!isRecord(col)) return {};
      const c: Record<string, unknown> = {};
      if (typeof col.name === "string") c.name = col.name;
      const displayName = typeof col.displayName === "string" ? col.displayName
        : typeof col.display_name === "string" ? col.display_name : undefined;
      if (displayName !== undefined) c.display_name = displayName;
      const dataType = typeof col.dataType === "string" ? col.dataType
        : typeof col.data_type === "string" ? col.data_type : undefined;
      if (dataType !== undefined) c.data_type = dataType;
      const hAlign = typeof col.horizontalAlign === "string" ? col.horizontalAlign
        : typeof col.horizontal_align === "string" ? col.horizontal_align : undefined;
      if (hAlign !== undefined) c.horizontal_align = hAlign;
      // width: pixels echo → "Npx"; builtin keyword (e.g. "auto") → verbatim.
      const wv = col.widthValue;
      if (isRecord(wv)) {
        if (wv.type === "pixels" && typeof wv.value === "number") c.width = `${wv.value}px`;
        else if (typeof wv.value === "string") c.width = wv.value;
      } else if (typeof col.width === "string" || typeof col.width === "number") {
        c.width = col.width;
      }
      if (isRecord(col.format)) c.format = col.format;
      return c;
    });

    const rawRows = Array.isArray(property.rows) ? property.rows : [];
    out.rows = rawRows.map((row) => {
      if (!isRecord(row)) return {};
      const r: Record<string, unknown> = {};
      for (const [k, cell] of Object.entries(row)) {
        // Unwrap the { data } envelope raw wraps every cell in.
        let value: unknown = isRecord(cell) && "data" in cell ? cell.data : cell;
        // A markdown cell holds a {tag:'markdown'} element — re-stitch to content.
        if (isRecord(value) && value.tag === "markdown" && isRecord(value.property)) {
          const elements = Array.isArray(value.property.elements) ? value.property.elements : [];
          value = renderChildren(elements, ctx);
        }
        r[k] = value;
      }
      return r;
    });

    if (isRecord(property.headerStyle)) {
      const hs: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(property.headerStyle)) {
        const sk = snake(k);
        // editor-only mirrors: platform size echo + int-wrapped line count.
        if (sk === "platform_text_size") continue;
        if (sk === "lines_value") {
          if (isRecord(v) && typeof v.value === "number") hs.lines = v.value;
          continue;
        }
        hs[sk] = v;
      }
      out.header_style = hs;
    }

    const rhv = property.rowHeightValue;
    if (isRecord(rhv) && typeof rhv.value === "string") out.row_height = rhv.value;
    else if (typeof property.rowHeight === "string") out.row_height = property.rowHeight;

    if (typeof property.pageSize === "number") out.page_size = property.pageSize;
    if (typeof property.freezeFirstColumn === "boolean") out.freeze_first_column = property.freezeFirstColumn;

    return out;
  }

  // input tag. The public schema is strict — many editor-only fields
  // (actions, autoResize, disabled:false, showCount, showIcon) cause
  // "unknown property" errors. We allowlist the fields we've seen on
  // archived cards. `required:false` is the editor default and the public
  // schema rejects it on input outside a form context, so we drop the
  // default and keep only an explicit true.
  if (tag === "input") {
    const allow = new Set(["name", "placeholder", "default_value", "value",
      "label", "label_position", "margin", "max_length", "input_type", "width"]);
    const out: Record<string, unknown> = { tag: "input" };
    const converted = convertProperty(property, "input", ctx) as Record<string, unknown>;
    for (const [k, v] of Object.entries(converted)) {
      if (allow.has(k)) out[k] = v;
    }
    if (converted.required === true) out.required = true;
    return out;
  }

  // person tag (single user avatar/name). The editor stores it as `person_v1`;
  // the public schema 2.0 tag is `person`, so we accept both and emit `person`.
  // Public shape: { tag:'person', user_id, size?, show_avatar?, show_name?,
  // style?, margin? }. Raw also ships pillShaped (public schema rejects it,
  // "unknown property pill_shaped") so we drop it, and a {top,right,bottom,left}
  // pixel margin the public DSL writes as an "Npx ..." box string.
  if (tag === "person" || tag === "person_v1") {
    const out: Record<string, unknown> = { tag: "person" };
    if (typeof property.userID === "string") out.user_id = property.userID;
    else if (typeof property.user_id === "string") out.user_id = property.user_id;
    if (typeof property.size === "string") out.size = property.size;
    if (typeof property.showAvatar === "boolean") out.show_avatar = property.showAvatar;
    if (typeof property.showName === "boolean") out.show_name = property.showName;
    if (typeof property.style === "string") out.style = property.style;
    if (isRecord(property.margin) && hasSide(property.margin)) out.margin = formatBox(property.margin);
    else if (typeof property.margin === "string") out.margin = property.margin;
    return out;
  }

  // person_list tag (a row of users). The public schema 2.0 is strict and the
  // editor envelope leaks several fields it rejects:
  //   - persons[i] carries { id, type:'user' }; the public shape is { id } only
  //     ("unknown property: type, path: ... persons -> [0]"), so we keep just id.
  //   - top-level `style`, `mode`, `count` are editor-only — dropped.
  //   - a sibling `fallback` node (outside property) is editor render state — dropped.
  // Public-allowed fields we project: show_avatar, show_name, size, lines,
  // drop_invalid_user_id, margin ({top,..} pixels -> "Npx ..." box), and icon
  // (kept as a flat { tag, token?, color?, img_key? }).
  if (tag === "person_list") {
    const out: Record<string, unknown> = { tag: "person_list" };
    if (typeof property.size === "string") out.size = property.size;
    if (typeof property.showAvatar === "boolean") out.show_avatar = property.showAvatar;
    if (typeof property.showName === "boolean") out.show_name = property.showName;
    if (typeof property.lines === "number") out.lines = property.lines;
    if (typeof property.dropInvalidUserID === "boolean") out.drop_invalid_user_id = property.dropInvalidUserID;
    else if (typeof property.drop_invalid_user_id === "boolean") out.drop_invalid_user_id = property.drop_invalid_user_id;
    if (isRecord(property.margin) && hasSide(property.margin)) out.margin = formatBox(property.margin);
    else if (typeof property.margin === "string") out.margin = property.margin;

    const rawPersons = Array.isArray(property.persons) ? property.persons : [];
    out.persons = rawPersons
      .map((p) => {
        if (!isRecord(p)) return undefined;
        const id = typeof p.id === "string" ? p.id : typeof p.userID === "string" ? p.userID : undefined;
        return id ? { id } : undefined;
      })
      .filter((p): p is { id: string } => p !== undefined);

    // icon / ud_icon prefix: project to the flat public shape, dropping the
    // editor's { id, property } wrapper. icon wins when both are present.
    const iconSrc = isRecord(property.icon) ? property.icon : isRecord(property.udIcon) ? property.udIcon : undefined;
    if (iconSrc) {
      const ip = isRecord(iconSrc.property) ? iconSrc.property : iconSrc;
      const icon: Record<string, unknown> = {};
      const iconTag = typeof iconSrc.tag === "string" ? iconSrc.tag : typeof ip.tag === "string" ? ip.tag : "standard_icon";
      icon.tag = iconTag === "ud_icon" ? "standard_icon" : iconTag;
      if (typeof ip.token === "string") icon.token = ip.token;
      if (typeof ip.color === "string") icon.color = ip.color;
      if (typeof ip.imageID === "string") icon.img_key = ip.imageID;
      else if (typeof ip.img_key === "string") icon.img_key = ip.img_key;
      if (icon.token !== undefined || icon.img_key !== undefined) out.icon = icon;
    }
    return out;
  }

  // `div` comes in two shapes, distinguished by its `text` child's tag:
  //
  //   v1 lark_md wrapper:  text.tag === 'markdown' | 'lark_md'
  //     Schema 2.0 has no div-wrapping-markdown; promote the markdown child to
  //     a top-level block element. (This is the live-bare-body fixture pattern.)
  //
  //   v2 icon-row:         text.tag === 'plain_text'  (optionally with `icon`)
  //     Schema 2.0 supports this div natively — confirmed against Feishu's own
  //     user_card_content, which keeps { tag:'div', text:{plain_text}, icon?,
  //     width? } here and PATCHes successfully. Earlier we unwrapped it, which
  //     both dropped the icon AND left a bare block-level plain_text that the
  //     PATCH API rejects (code 200621). So we now preserve the div.
  //
  //   v1 fields layout:    property.fields present
  //     No clean 2.0 equivalent; fall through to the generic path.
  if (tag === "div" && isRecord(property.text) && property.fields === undefined) {
    const text = property.text as Record<string, unknown>;
    const textTag = typeof text.tag === "string" ? text.tag : "";

    if ((textTag === "markdown" || textTag === "lark_md") && isRecord(text.property)) {
      return unwrap(text, ctx);
    }

    if (textTag === "plain_text") {
      const out: Record<string, unknown> = { tag: "div" };

      // width: a builtin widthValue keyword (e.g. "fill") or a plain width string.
      const widthVal = property.widthValue;
      if (
        isRecord(widthVal) &&
        typeof widthVal.value === "string" &&
        typeof widthVal.type === "string" &&
        widthVal.type.startsWith("builtin_")
      ) {
        out.width = widthVal.value;
      } else if (typeof property.width === "string") {
        out.width = property.width;
      }

      // text: leaf plain_text (kept as plain_text, NOT promoted to a block).
      const tp = isRecord(text.property) ? text.property : {};
      const content = typeof tp.content === "string" ? tp.content : "";
      const textAlign = typeof tp.textAlign === "string" ? tp.textAlign : "left";
      out.text = { tag: "plain_text", content, text_align: textAlign };

      // icon: standard_icon — reuse the existing unwrap path.
      if (isRecord(property.icon)) {
        out.icon = unwrap(property.icon as Record<string, unknown>, ctx);
      }

      return out;
    }
  }

  const converted = convertProperty(property, tag, ctx) as Record<string, unknown>;
  return tag ? { tag, ...converted } : converted;
}

/* ------------------------------------------------------------------ *
 * Per-property walker
 * ------------------------------------------------------------------ */

const DROP: unique symbol = Symbol("drop");
type FieldResult = readonly [string, unknown] | typeof DROP;

/**
 * Siblings the per-field walker peeks at to disambiguate. Populated by
 * convertProperty up-front so `convertField` can branch without having to
 * look up the parent.
 */
interface Siblings {
  buttonActionType?: string;
}

function convertProperty(
  property: Record<string, unknown>,
  ownerTag: string | undefined,
  ctx: Ctx,
): unknown {
  const out: Record<string, unknown> = {};

  // Capture sibling-disambiguation fields up-front so per-field rules can use
  // them (button.actions needs button.actionType to decide multi_url vs
  // behaviors; the value is then dropped by the regular `action_type` rule).
  const siblings: Siblings = {
    buttonActionType: ownerTag === "button" && typeof property.actionType === "string"
      ? property.actionType
      : undefined,
  };

  // First pass: convert each field individually.
  for (const [rawKey, rawValue] of Object.entries(property)) {
    const result = convertField(rawKey, rawValue, ownerTag, ctx, siblings);
    if (result === DROP) continue;
    const [outKey, outValue] = result;
    if (outValue === DROP) continue;
    out[outKey] = outValue;
  }

  // Reconcile *_value echoes onto the sibling enum, then drop the echo.
  // The editor mirrors a precise value next to a coarse enum:
  //   - widthValue:{type:'pixels',value:72} alongside width:'auto'
  //   - widthValue:{type:'builtin_width',value:'default'} (no enum sibling)
  //   - horizontalSpacingValue:{type:'pixels',value:6} alongside horizontal_spacing:'default'
  // Public DSL keeps just the enum slot, holding a string-pixel ("6px") or a
  // keyword ("default"). When the echo carries genuinely new info (a pixel
  // count, or a builtin keyword the enum doesn't yet hold), fold it in.
  for (const [echoKey, enumKey] of Object.entries(VALUE_ECHO_TARGETS)) {
    if (!(echoKey in out)) continue;
    const echoVal = out[echoKey];
    const enumVal = out[enumKey];
    delete out[echoKey];
    if (!isRecord(echoVal)) continue;
    const echoType = typeof echoVal.type === "string" ? echoVal.type : "";
    const echoValue = echoVal.value;

    // Pixel echo: project as "Npx" when the enum slot is missing or coarse.
    if (echoType.includes("pixels") && typeof echoValue === "number") {
      if (
        enumVal === undefined ||
        enumVal === "default" ||
        enumVal === "auto" ||
        enumVal === "weighted"
      ) {
        out[enumKey] = `${echoValue}px`;
      }
      continue;
    }

    // Aspect-ratio echo (img.size_value): { type:'aspect_ratio', value:{height,width} }.
    // Public DSL writes "W:H" verbatim on img.size.
    if (echoType === "aspect_ratio" && isRecord(echoValue)) {
      const w = echoValue.width;
      const h = echoValue.height;
      if (typeof w === "number" && typeof h === "number") {
        out["size"] = `${w}:${h}`;
      }
      continue;
    }

    // Width/height pixel pair (img.size_value): { type:'width_height_pixels', value:{width,height} }.
    // Public DSL writes "Wpx Hpx" on img.size — load-bearing for grid layouts;
    // when these images are dropped to "no explicit size" the renderer auto-sizes
    // each cell independently and the grid loses its row alignment.
    if (echoType === "width_height_pixels" && isRecord(echoValue)) {
      const w = echoValue.width;
      const h = echoValue.height;
      if (typeof w === "number" && typeof h === "number") {
        out["size"] = `${w}px ${h}px`;
      }
      continue;
    }

    // Builtin keyword echo (e.g. builtin_width:"default"): use the value
    // verbatim when the enum slot is missing. img.size_value of
    // "builtin_image_size:stretch" is the editor default that archives
    // never write — drop it instead of synthesizing size:"stretch".
    if (echoType === "builtin_image_size") continue;
    if (echoType.startsWith("builtin_") && typeof echoValue === "string") {
      if (enumVal === undefined) out[enumKey] = echoValue;
      continue;
    }

    // column_width_weighted echoes are redundant with width:'weighted' / weight, drop.
  }

  // Drop per-tag editor defaults.
  if (ownerTag && TAG_DEFAULT_DROPS[ownerTag]) {
    const defaults = TAG_DEFAULT_DROPS[ownerTag];
    for (const [k, defVal] of Object.entries(defaults)) {
      if (out[k] === defVal) delete out[k];
    }
  }

  return out;
}

function convertField(
  rawKey: string,
  rawValue: unknown,
  ownerTag: string | undefined,
  ctx: Ctx,
  siblings: Siblings = {},
): FieldResult {
  if (rawKey === "originTag" || rawKey === "markdownElements") return DROP;

  const key = snake(rawKey);

  if (RAW_ONLY_FIELDS.has(key)) return DROP;
  if (isI18nMirror(key)) return DROP;

  // `actions: []` is the raw editor's "no click action wired up" placeholder.
  // The public DSL omits it. Non-empty actions arrays are kept and remapped
  // by per-tag rules below.
  if (key === "actions" && Array.isArray(rawValue) && rawValue.length === 0) {
    return DROP;
  }

  // Box fields (padding / margin): { top, right, bottom, left } → "Tpx Rpx Bpx Lpx".
  if ((key === "padding" || key === "margin") && isRecord(rawValue) && hasSide(rawValue)) {
    return [key, formatBox(rawValue)];
  }

  // *_value echo fields: keep the raw object until reconciliation can fold
  // it back onto the sibling enum. Reconciliation runs in convertProperty
  // after every field has been visited.
  if (key in VALUE_ECHO_TARGETS) {
    return [key, rawValue];
  }

  // Other scalar pixel objects (corner_radius, icon size, etc.) get folded
  // into a "Npx" string immediately.
  if (isPixelScalar(rawValue)) {
    return [key, `${pixelOf(rawValue as Record<string, unknown>)}px`];
  }

  // img: imageID -> img_key (resolve via attachment table).
  if (ownerTag === "img" && key === "image_id") {
    const id = typeof rawValue === "string" || typeof rawValue === "number" ? String(rawValue) : undefined;
    const origin = id !== undefined ? ctx.images[id]?.origin_key : undefined;
    if (origin) return ["img_key", origin];
    return [key, rawValue];
  }
  if (ownerTag === "img" && IMG_RAW_ONLY_FIELDS.has(key)) return DROP;

  // alt / hover_tips / button.text / column header text: nested plain_text.
  if ((key === "alt" || key === "hover_tips") && isRecord(rawValue) && rawValue.tag === "plain_text") {
    const p = isRecord(rawValue.property) ? rawValue.property : {};
    return [key, { tag: "plain_text", content: typeof p.content === "string" ? p.content : "" }];
  }

  // button.text, interactive_container hover_tips: same plain_text leaf treatment.
  if (key === "text" && isRecord(rawValue) && rawValue.tag === "plain_text") {
    const p = isRecord(rawValue.property) ? rawValue.property : {};
    return [key, { tag: "plain_text", content: typeof p.content === "string" ? p.content : "" }];
  }

  // header.udIcon → header.icon (rebuilt as standard_icon). The udIcon
  // wrapper in raw is { id, tag:'ud_icon', property:{ imageID, token, style } };
  // in public DSL this lives at header.icon as { tag:'standard_icon', token }.
  if (ownerTag === "header" && key === "ud_icon" && isRecord(rawValue) && rawValue.tag === "ud_icon") {
    const p = isRecord(rawValue.property) ? rawValue.property : {};
    const token = typeof p.token === "string" ? p.token : undefined;
    if (!token) return DROP;
    return ["icon", { tag: "standard_icon", token }];
  }

  // collapsible_panel.header is a plain bag (not tag/property wrapped). Its
  // raw shape carries layout fields the public DSL never reads — drop them.
  if (ownerTag === "collapsible_panel" && key === "header" && isRecord(rawValue)) {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rawValue)) {
      const sk = snake(k);
      // editor-only layout residue inside a collapsible_panel header.
      if (sk === "position" || sk === "width" || sk === "vertical_align") continue;
      const sub = convertField(k, v, "collapsible_panel_header", ctx, siblings);
      if (sub === DROP) continue;
      const [subKey, subVal] = sub;
      if (subVal === DROP) continue;
      cleaned[subKey] = subVal;
    }
    return [key, cleaned];
  }

  // button.actions → behaviors / multi_url. Raw distinguishes:
  //   actionType:"multi" + actions:[{action:{url},type:"open_url"}]
  //     -> behaviors:[{type:"open_url", default_url:url, pc_url, ios_url, android_url}]
  //   actionType:"link" + actions:[{action:{url},type:"open_url"}]
  //     -> multi_url:{url, pc_url, ios_url, android_url}
  //   action_request callbacks live above the DSL (cardkit entity handles
  //     them via card_id-stamped buttons); we drop them.
  // The `actionType` field is editor-internal, dropped after dispatch.
  if (ownerTag === "button" && key === "action_type") return DROP;
  if (ownerTag === "button" && key === "actions" && Array.isArray(rawValue)) {
    const openUrls: string[] = [];
    for (const a of rawValue) {
      if (!isRecord(a)) continue;
      const inner = isRecord(a.action) ? a.action : {};
      const t = typeof a.type === "string" ? a.type : undefined;
      if (t === "open_url" && typeof inner.url === "string") openUrls.push(inner.url);
      // action_request callbacks belong to the cardkit entity layer; drop.
    }
    if (openUrls.length === 0) return DROP;
    if (siblings.buttonActionType === "link") {
      return ["multi_url", { url: openUrls[0] }];
    }
    // Default to behaviors (matches actionType:"multi" and the more common shape).
    return [
      "behaviors",
      openUrls.map((url) => ({ type: "open_url", default_url: url })),
    ];
  }

  // interactive_container click interaction. The raw editor stores it as
  // `actions: [{ type:'open_url', action:{ url } }]` (or a callback). But the
  // public DSL 2.0 has NO `actions` property on interactive_container — the
  // click config is `behaviors` (required), the same shape buttons use:
  //   open_url  -> { type:'open_url', default_url: url }
  //   callback  -> { type:'callback', value }
  // Emitting `actions` makes Feishu reject the card ("unknown property: actions").
  if (ownerTag === "interactive_container" && key === "actions" && Array.isArray(rawValue)) {
    const behaviors = rawValue
      .map((a): Record<string, unknown> | undefined => {
        if (!isRecord(a)) return undefined;
        const inner = isRecord(a.action) ? a.action : {};
        const t = typeof a.type === "string" ? a.type : undefined;
        if (t === "open_url" && typeof inner.url === "string") {
          return { type: "open_url", default_url: inner.url };
        }
        if (t === "callback") {
          return { type: "callback", value: inner.value ?? {} };
        }
        return undefined;
      })
      .filter((b): b is Record<string, unknown> => b !== undefined);
    if (behaviors.length === 0) return DROP;
    return ["behaviors", behaviors];
  }

  // border: { borderColor, cornerRadius:{type,value} } -> { color, corner_radius:"Npx" }
  if (key === "border" && isRecord(rawValue)) {
    const b = rawValue as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof b.borderColor === "string") out.color = b.borderColor;
    else if (typeof b.color === "string") out.color = b.color;
    if (isPixelScalar(b.cornerRadius)) out.corner_radius = `${pixelOf(b.cornerRadius as Record<string, unknown>)}px`;
    else if (typeof b.cornerRadius === "string") out.corner_radius = b.cornerRadius;
    else if (b.cornerRadius !== undefined) out.corner_radius = b.cornerRadius;
    // Pass through other border keys verbatim (snake_cased) for forward-compat.
    for (const [bk, bv] of Object.entries(b)) {
      if (bk === "borderColor" || bk === "cornerRadius" || bk === "color") continue;
      out[snake(bk)] = convertGeneric(bv, ctx);
    }
    return [key, out];
  }

  // url object on link / open_url: { url, androidURL, iosURL, pcURL, harmonyURL }.
  if (key === "url" && isRecord(rawValue)) {
    const v = rawValue as Record<string, unknown>;
    const main = typeof v.url === "string" ? v.url : "";
    const others = ["androidURL", "iosURL", "pcURL", "harmonyURL"]
      .map((k) => v[k])
      .filter((x) => typeof x === "string" && x.length > 0);
    if (others.length === 0) return [key, main];
    return [
      key,
      {
        url: main,
        android_url: typeof v.androidURL === "string" ? v.androidURL : "",
        ios_url: typeof v.iosURL === "string" ? v.iosURL : "",
        pc_url: typeof v.pcURL === "string" ? v.pcURL : "",
      },
    ];
  }

  // markdown.icon (in form columns) lives under a column.markdown wrapper —
  // generic recursion handles it via unwrap.

  // Generic recursion for everything else.
  return [key, convertGeneric(rawValue, ctx)];
}

/* ------------------------------------------------------------------ *
 * Markdown re-stitch
 * ------------------------------------------------------------------ */

/**
 * Markdown elements in raw split the original source string across multiple
 * children: plain_text segments (optionally with bold/color), at_all, br,
 * link, code_span, text_tag, person_v1, etc. We re-stitch them into a single
 * content string with inline markdown markers — bold (asterisk asterisk),
 * font tag, link, code span, br -> newline, at -> at-tag, person_v1 ->
 * <person> tag.
 */

/**
 * Project a raw person / person_v1 markdown child to the public inline
 * `<person id='...' show_name=... show_avatar=... style='...'></person>`
 * syntax. Without this, person segments fall through to the default case
 * and vanish on round-trip (leaving only surrounding plain_text / at).
 * `pillShaped` is editor-only and rejected by the public schema — drop it.
 */
function renderInlinePerson(prop: Record<string, unknown>): string {
  const id = typeof prop.userID === "string" ? prop.userID
    : typeof prop.user_id === "string" ? prop.user_id
    : typeof prop.id === "string" ? prop.id
    : "";
  if (!id) return "";
  const parts = [`id='${id}'`];
  if (typeof prop.showName === "boolean") parts.push(`show_name=${prop.showName}`);
  else if (typeof prop.show_name === "boolean") parts.push(`show_name=${prop.show_name}`);
  if (typeof prop.showAvatar === "boolean") parts.push(`show_avatar=${prop.showAvatar}`);
  else if (typeof prop.show_avatar === "boolean") parts.push(`show_avatar=${prop.show_avatar}`);
  if (typeof prop.style === "string") parts.push(`style='${prop.style}'`);
  return `<person ${parts.join(" ")}></person>`;
}
function rebuildMarkdown(property: Record<string, unknown>, ctx: Ctx): unknown {
  const out: Record<string, unknown> = { tag: "markdown" };
  const elements = Array.isArray(property.elements) ? property.elements : [];
  const content = renderChildren(elements, ctx);
  if (content) out.content = content;

  for (const [rawKey, rawValue] of Object.entries(property)) {
    if (rawKey === "elements" || rawKey === "markdownElements" || rawKey === "originTag") continue;

    // Raw markdown ships both `icon` (standard_icon) and `udIcon` (ud_icon)
    // pointing at the same token. The public DSL keeps only `icon`. Drop the
    // udIcon shadow.
    if (rawKey === "udIcon") continue;

    if (rawKey === "textStyle") {
      // Project textStyle.size onto a flat text_size field. raw mirrors it
      // as platformSize too, but size is the canonical anchor.
      const ts = isRecord(rawValue) ? rawValue : {};
      const size = typeof ts.size === "string" ? ts.size : undefined;
      if (size) out.text_size = size;
      continue;
    }

    const result = convertField(rawKey, rawValue, "markdown", ctx);
    if (result === DROP) continue;
    const [outKey, outValue] = result;
    if (outValue === DROP) continue;
    out[outKey] = outValue;
  }

  return out;
}

/**
 * Render a sequence of markdown children. Inline children (plain_text /
 * code_span / link / at / text_tag with attribute styling) are converted to
 * { content, bold, color } segments and **adjacent same-styled segments are
 * merged before being wrapped** so a run like
 *     plain_text bold("方案 2：") + code_span bold("/clear") + plain_text bold(" 后再开始")
 * collapses to a single bold range
 *     **方案 2：`/clear` 后再开始**
 * instead of three independent bold ranges, which markdown can't reconnect
 * across the intervening code span.
 *
 * Block children (br, hr, list, heading, blockquote, code_block, table) flush
 * the inline buffer, render themselves with their own paragraph breaks, and
 * leave the buffer empty for the next inline run.
 */
/**
 * Wrap text in bold / font markers, keeping surrounding whitespace OUTSIDE the
 * markers. CommonMark forbids an emphasis run's `**` from hugging whitespace —
 * `**1. **` (space before the closing `**`) does NOT render bold, it prints the
 * literal asterisks. The editor stores bold segments with trailing/leading
 * spaces ("1. ", "· "), so we emit `**1.** ` instead of `**1. **`. An
 * all-whitespace run carries no emphasis. `<font>` tags don't share the
 * whitespace restriction, but moving spaces out is harmless and keeps the two
 * markers nestable.
 */
function wrapEmphasis(text: string, bold: boolean, color?: string): string {
  if (!bold && !color) return text;
  const lead = text.match(/^\s*/)![0];
  const trail = text.match(/\s*$/)![0];
  const core = text.slice(lead.length, text.length - trail.length);
  if (core.length === 0) return text;
  let wrapped = core;
  if (bold) wrapped = `**${wrapped}**`;
  if (color) wrapped = `<font color='${color}'>${wrapped}</font>`;
  return lead + wrapped + trail;
}

function renderChildren(children: unknown[], ctx: Ctx): string {
  interface Segment { content: string; bold: boolean; color?: string }
  let out = "";
  let buffer: Segment[] = [];

  function flushBuffer() {
    if (buffer.length === 0) return;
    // Group adjacent segments with identical styling, then wrap each group.
    let group: Segment[] = [];
    function emitGroup() {
      if (group.length === 0) return;
      const inner = group.map((s) => s.content).join("");
      const { bold, color } = group[0]!;
      out += wrapEmphasis(inner, bold, color);
      group = [];
    }
    for (const seg of buffer) {
      if (group.length === 0) { group.push(seg); continue; }
      const head = group[0]!;
      if (head.bold === seg.bold && head.color === seg.color) group.push(seg);
      else { emitGroup(); group.push(seg); }
    }
    emitGroup();
    buffer = [];
  }

  for (const child of children) {
    if (!isRecord(child)) continue;
    const inline = childToInlineSegment(child, ctx);
    if (inline) { buffer.push(inline); continue; }
    flushBuffer();
    out += childToMarkdown(child, ctx);
  }
  flushBuffer();
  return out;
}

/**
 * Convert an inline child into a styled segment, or return undefined if the
 * child is block-level. The caller (renderChildren) routes block-level
 * children to childToMarkdown instead — they own their own paragraph breaks.
 */
function childToInlineSegment(
  child: Record<string, unknown>,
  ctx: Ctx,
): { content: string; bold: boolean; color?: string } | undefined {
  const tag = child.tag;
  const prop = isRecord(child.property) ? child.property : {};
  const ts = isRecord(prop.textStyle) ? prop.textStyle : undefined;
  const bold = !!(ts && Array.isArray(ts.attributes) && (ts.attributes as unknown[]).includes("bold"));
  // "default" is the no-op color — emitting <font color='default'> is just
  // noise (and the raw editor stamps it on otherwise-unstyled text), so treat
  // it as absent.
  const rawColor = ts && typeof ts.color === "string" ? ts.color : undefined;
  const color = rawColor === "default" ? undefined : rawColor;

  switch (tag) {
    case "plain_text":
      return {
        content: typeof prop.content === "string" ? prop.content : "",
        bold,
        color,
      };
    case "code_span":
      return {
        content: `\`${typeof prop.content === "string" ? prop.content : ""}\``,
        bold,
        color,
      };
    case "link": {
      const text = typeof prop.content === "string" ? prop.content : "";
      const urlObj = isRecord(prop.url) ? prop.url : undefined;
      const url = urlObj && typeof urlObj.url === "string" ? urlObj.url : "";
      return { content: `[${text}](${url})`, bold, color };
    }
    case "at_all":
      return { content: "<at id=all></at>", bold, color };
    case "at": {
      const userId = typeof prop.userId === "string" ? prop.userId
        : typeof prop.user_id === "string" ? prop.user_id
        : (() => {
            const key = typeof prop.atUserKey === "string" ? prop.atUserKey : undefined;
            if (key && ctx.atUsers[key]) return ctx.atUsers[key].user_id;
            return undefined;
          })();
      return { content: userId ? `<at id=${userId}></at>` : "<at></at>", bold, color };
    }
    case "text_tag": {
      // text_tag has its own color rendering; treat it as opaque inline content
      // so it doesn't get re-wrapped by adjacent bold/color groupings.
      const tagColor = typeof prop.color === "string" ? prop.color : undefined;
      const inner = isRecord(prop.text) ? prop.text : undefined;
      const innerProp = inner && isRecord(inner.property) ? inner.property : undefined;
      const innerContent = innerProp && typeof innerProp.content === "string" ? innerProp.content : "";
      const rendered = tagColor
        ? `<text_tag color='${tagColor}'>${innerContent}</text_tag>`
        : `<text_tag>${innerContent}</text_tag>`;
      return { content: rendered, bold: false };
    }
    case "emoji": {
      // Inline emoji: raw carries just the shortcode key (`{ key:'OK' }`); the
      // public DSL markdown syntax is `:KEY:`. Without this the segment falls to
      // default (dropped) and the card loses every emoji on round-trip. Emit it
      // as its own inline segment — no bold/color, they don't apply to emoji.
      const key = typeof prop.key === "string" ? prop.key
        : typeof prop.emojiKey === "string" ? prop.emojiKey
        : "";
      return key ? { content: `:${key}:`, bold: false } : undefined;
    }
    case "person":
    case "person_v1": {
      // Inline person chip inside markdown. Opaque like text_tag / emoji —
      // don't inherit adjacent bold/color wrapping.
      const rendered = renderInlinePerson(prop);
      return rendered ? { content: rendered, bold: false } : undefined;
    }
    default:
      return undefined;
  }
}

function childToMarkdown(child: Record<string, unknown>, ctx: Ctx): string {
  const tag = child.tag;
  const prop = isRecord(child.property) ? child.property : {};

  switch (tag) {
    case "plain_text": {
      const content = typeof prop.content === "string" ? prop.content : "";
      const ts = isRecord(prop.textStyle) ? prop.textStyle : undefined;
      const color = ts && typeof ts.color === "string" ? ts.color : undefined;
      const attrs = ts && Array.isArray(ts.attributes) ? (ts.attributes as unknown[]) : [];
      return wrapEmphasis(content, attrs.includes("bold"), color);
    }
    case "br":
      return "\n";
    case "emoji": {
      // Inline emoji shortcode. Also reachable here (not just via
      // childToInlineSegment) when an emoji sits inside a list item / heading /
      // blockquote, which recurse through childToMarkdown. Public syntax `:KEY:`.
      const key = typeof prop.key === "string" ? prop.key
        : typeof prop.emojiKey === "string" ? prop.emojiKey
        : "";
      return key ? `:${key}:` : "";
    }
    case "at_all":
      // @-all in raw uses an at_users entry keyed "all". The public mention
      // syntax for everyone is <at id=all></at>.
      return "<at id=all></at>";
    case "at": {
      // Single-user @: raw stores user_id under the property; if it
      // references the at_users attachment table, pull it from there.
      const userId = typeof prop.userId === "string" ? prop.userId
        : typeof prop.user_id === "string" ? prop.user_id
        : (() => {
            const key = typeof prop.atUserKey === "string" ? prop.atUserKey : undefined;
            if (key && ctx.atUsers[key]) return ctx.atUsers[key].user_id;
            return undefined;
          })();
      return userId ? `<at id=${userId}></at>` : "<at></at>";
    }
    case "person":
    case "person_v1":
      // Also reachable via list/heading/blockquote recursion through
      // childToMarkdown (same as emoji). Public inline syntax <person ...>.
      return renderInlinePerson(prop);
    case "link": {
      const text = typeof prop.content === "string" ? prop.content : "";
      const urlObj = isRecord(prop.url) ? prop.url : undefined;
      const url = urlObj && typeof urlObj.url === "string" ? urlObj.url : "";
      return `[${text}](${url})`;
    }
    case "code_span": {
      const text = typeof prop.content === "string" ? prop.content : "";
      return `\`${text}\``;
    }
    case "text_tag": {
      const color = typeof prop.color === "string" ? prop.color : undefined;
      const inner = isRecord(prop.text) ? prop.text : undefined;
      const innerProp = inner && isRecord(inner.property) ? inner.property : undefined;
      const innerContent = innerProp && typeof innerProp.content === "string" ? innerProp.content : "";
      if (color) return `<text_tag color='${color}'>${innerContent}</text_tag>`;
      return `<text_tag>${innerContent}</text_tag>`;
    }
    case "code_block": {
      // raw code_block: property.contents is an array of LINES; each line is
      // { contents: [{ content, contentType }] } whose inner segments
      // concatenate into that line's text. Lines must be rejoined with "\n" —
      // the editor stores the newline as the boundary between outer entries,
      // not as a character inside any segment, so a naive concat collapses a
      // multi-line block into a single line.
      const lang = typeof prop.language === "string" ? prop.language : "";
      const blocks = Array.isArray(prop.contents) ? prop.contents : [];
      const lines = blocks.map((blk) => {
        if (!isRecord(blk)) return "";
        const inner = Array.isArray(blk.contents) ? blk.contents : [];
        let line = "";
        for (const seg of inner) {
          if (isRecord(seg) && typeof seg.content === "string") line += seg.content;
        }
        return line;
      });
      // Two raw encodings exist: one stores each line as a separate outer
      // entry (no newline chars), another packs everything into one entry with
      // explicit "\n" segments. Joining with "\n" then trimming trailing
      // newlines normalizes both before we add a single closing-fence break.
      const body = lines.join("\n").replace(/\n+$/, "");
      return `\n\`\`\`${lang}\n${body}\n\`\`\`\n`;
    }
    case "list": {
      // raw list: { items: [{ elements:[plain_text...], level:0|1|..., type:'ul'|'ol' }] }
      // Project to inline markdown bullets / numbers, level*2-space indent.
      // We emit a leading "\n" only — the upstream br/plain_text in the
      // sibling stream contributes its own newline, which stacks to the
      // archived convention of "...prev_line\n\n- bullet".
      const items = Array.isArray(prop.items) ? prop.items : [];
      const lines: string[] = [];
      let counter = 0;
      let lastType: string | undefined;
      for (const item of items) {
        if (!isRecord(item)) continue;
        const level = typeof item.level === "number" ? item.level : 0;
        const type = typeof item.type === "string" ? item.type : "ul";
        if (type !== lastType) counter = 0;
        lastType = type;
        const indent = "  ".repeat(level);
        const inner = Array.isArray(item.elements) ? item.elements : [];
        let text = "";
        for (const seg of inner) {
          if (!isRecord(seg)) continue;
          text += childToMarkdown(seg, ctx);
        }
        if (type === "ol") {
          counter += 1;
          lines.push(`${indent}${counter}. ${text}`);
        } else {
          lines.push(`${indent}- ${text}`);
        }
      }
      // List is a block-level construct. It opens its own paragraph and MUST
      // terminate with a blank line (\n\n), not a single \n: in Feishu markdown
      // a lone trailing \n is not enough to close the list block, so a
      // following sibling plain_text gets parsed as a continuation of the last
      // bullet and renders glued onto the same line. Emitting \n\n forces the
      // block closed (matches the heading/hr/blockquote handling below). Feishu
      // collapses any resulting extra blank line, so this is safe even when the
      // sibling stream already contributes its own break.
      return `\n${lines.join("\n")}\n\n`;
    }
    case "heading": {
      // raw heading: { property: { elements:[plain_text...], level:1|2|3|... } }
      // Public DSL writes "# " / "## " / "### " inline. Heading occupies its
      // own paragraph; raw doesn't always emit `br` siblings around it, so we
      // surround the line with blank lines ourselves. Otherwise an upstream
      // plain_text gets glued onto the heading line ("...continuation## title")
      // and a downstream plain_text gets glued after it ("## title body...").
      const level = typeof prop.level === "number" ? prop.level : 1;
      const inner = Array.isArray(prop.elements) ? prop.elements : [];
      let body = "";
      for (const seg of inner) {
        if (isRecord(seg)) body += childToMarkdown(seg, ctx);
      }
      return `\n\n${"#".repeat(level)} ${body}\n\n`;
    }
    case "hr": {
      // raw markdown can contain a horizontal rule child. archive convention
      // renders it on its own paragraph with a blank line on each side so the
      // "---" doesn't get glued to the surrounding plain_text.
      return "\n\n---\n\n";
    }
    case "table": {
      // raw table:
      //   property: {
      //     columns: [{ dataType, displayName, name:"0"|"1"|... }],
      //     rows:    [{ "0":{data:{tag:"markdown",property:{elements:[...]}}}, ... }],
      //     headerStyle, pageSize, freezeFirstColumn
      //   }
      // user_card_content already degrades this into a markdown pipe table
      // ("| col | col |\n| --- | --- |\n| a | b |"), so we mirror that shape
      // for parity. Cell content is the inline render of its markdown element.
      const columns = Array.isArray(prop.columns) ? prop.columns : [];
      const rows = Array.isArray(prop.rows) ? prop.rows : [];
      if (columns.length === 0) return "";
      const headers = columns.map((col) =>
        isRecord(col) && typeof col.displayName === "string" ? col.displayName : "",
      );
      const headerLine = `| ${headers.join(" | ")} |`;
      const separator = `| ${columns.map(() => "--------").join(" | ")} |`;
      const bodyLines = rows.map((row) => {
        if (!isRecord(row)) return `| ${columns.map(() => "").join(" | ")} |`;
        const cells = columns.map((col) => {
          const name = isRecord(col) && typeof col.name === "string" ? col.name : "";
          const cell = isRecord(row[name]) ? (row[name] as Record<string, unknown>) : undefined;
          const data = cell && isRecord(cell.data) ? cell.data : undefined;
          if (!data || data.tag !== "markdown") return "";
          const cellProp = isRecord(data.property) ? data.property : {};
          const inner = Array.isArray(cellProp.elements) ? cellProp.elements : [];
          // Use renderChildren so adjacent same-styled segments merge
          // (e.g. bold runs spanning a code_span don't get split).
          const text = renderChildren(inner, ctx);
          return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
        });
        return `| ${cells.join(" | ")} |`;
      });
      return `\n\n${headerLine}\n${separator}\n${bodyLines.join("\n")}\n\n`;
    }
    case "blockquote": {
      const inner = Array.isArray(prop.elements) ? prop.elements : [];
      let body = "";
      for (const seg of inner) {
        if (isRecord(seg)) body += childToMarkdown(seg, ctx);
      }
      // archive convention: blockquote sits on its own paragraph, with a "> "
      // prefix on every line and blank lines on both sides. Raw doesn't emit
      // br around blockquote, so we supply both breaks ourselves.
      return `\n\n> ${body.replace(/\n/g, "\n> ")}\n\n`;
    }
    default:
      // Unknown leaf — render its `content` if any, else nothing. We don't
      // throw, since raw may add new inline element types.
      return typeof prop.content === "string" ? prop.content : "";
  }
}

/* ------------------------------------------------------------------ *
 * Generic recursion + helpers
 * ------------------------------------------------------------------ */

function convertGeneric(value: unknown, ctx: Ctx): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (isRecord(item) && typeof item.tag === "string" && isRecord(item.property)) {
        return unwrap(item, ctx);
      }
      return convertGeneric(item, ctx);
    });
  }
  if (isRecord(value)) {
    if (typeof value.tag === "string" && isRecord(value.property)) {
      return unwrap(value, ctx);
    }
    // Box-shaped object at a generic depth: format it.
    if (hasSide(value)) {
      return formatBox(value);
    }
    if (isPixelScalar(value)) {
      return `${pixelOf(value)}px`;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[snake(k)] = convertGeneric(v, ctx);
    }
    return out;
  }
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function hasSide(v: Record<string, unknown>): boolean {
  return ("top" in v || "bottom" in v || "left" in v || "right" in v) &&
    Object.values(v).some((side) => isRecord(side) && "type" in side && "value" in side);
}

function formatBox(v: Record<string, unknown>): string {
  return `${pixelOf(v.top)}px ${pixelOf(v.right)}px ${pixelOf(v.bottom)}px ${pixelOf(v.left)}px`;
}

function isPixelScalar(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return typeof v.type === "string" && v.type.includes("pixels") && typeof v.value === "number";
}

function pixelOf(side: unknown): number {
  if (!isRecord(side)) return 0;
  const v = side.value;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function snake(key: string): string {
  return key
    .replace(/ID$/g, "_id")
    .replace(/URL$/g, "_url")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

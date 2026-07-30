# feishu-raw-card-to-dsl

把飞书 `im.message.get` 用 `card_msg_content_type: "raw_card_content"` 拉到的**编辑器内部 envelope**，转换成公开 [JSON Schema 2.0 卡片 DSL](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/feishu-cards/card-json-v2-structure)。

零依赖，纯函数。

## 为什么需要它

飞书发送卡片用公开 DSL（JSON Schema 2.0），但同样的卡片用 `im.message.get` 拉回来时，飞书有两种内容形态可选：

| 模式 | 字段完整度 | 适合做什么 |
|---|---|---|
| `user_card_content`（默认/常用） | **有损**：等于服务端默认值的字段被剥掉 | 只读展示 |
| `raw_card_content` | 完整：保留每个原始字段 | 改完重发 |

最痛的丢字段案例：`column.padding`。当 column 带非默认 `background_style`（比如 `red-50`、`grey-50`）时，飞书渲染会自动给 12px 内边距，但这个 12px 在 `user_card_content` 返回里**没了**。把这种 DSL 重新发出去，彩色块紧贴边缘，看起来全坏。

`raw_card_content` 解决了字段完整性问题，**但代价是返回的不是公开 DSL**：

- 每个 element 包成 `{id, tag, property: {...}}`
- 字段名是 camelCase（`textAlign` / `imageID` / `widthValue` / ...）
- padding/margin 是对象 `{top:{type:"pixels",value:12}, ...}` 而不是 `"12px ..."` 字符串
- img 用 `imageID` 指向旁路的 `json_attachment.images` 表
- markdown 内容拆成 plain_text / br / list / heading / link / text_tag / code_span / code_block / at_all / blockquote 等子元素，需要重新拼回 inline markdown 字符串
- header 包成 `tag:'card_header'`，带 `udIcon` 而不是 `icon`
- chart_spec 内部用 vega/vchart 的 camelCase（不能 snake_case）
- 大量编辑器内部字段（`disabled:false` / `actions:[]` / `showCount` / `pillShaped` / `min_lib_version` / ...）公开 schema 不接受，重发会被飞书拒

这个库专门处理 raw envelope → 公开 DSL 的转换。基于 250+ 张真实归档卡片做回归对齐。

## 安装

```bash
npm install feishu-raw-card-to-dsl
# 或
pnpm add feishu-raw-card-to-dsl
```

## 用法

```ts
import { rawCardToDsl, isRawCardEnvelope } from "feishu-raw-card-to-dsl";
import * as lark from "@larksuiteoapi/node-sdk";

const client = new lark.Client({ appId, appSecret });

const response = await client.im.message.get({
  path: { message_id: "om_xxx" },
  params: {
    // @ts-expect-error SDK 类型滞后；raw_card_content 是文档化的合法值
    card_msg_content_type: "raw_card_content",
  },
});

const item = response.data?.items?.[0];
const rawContent = item?.body?.content;
if (typeof rawContent !== "string") throw new Error("not a card message");

const envelope = JSON.parse(rawContent);
if (!isRawCardEnvelope(envelope)) {
  // 老消息 / 模板卡 / 非 raw 形态：直接用原解析结果或 fall back 到 user_card_content
  console.log(envelope);
} else {
  const dsl = rawCardToDsl(envelope);
  // dsl 现在是 { schema:"2.0", config:{update_multi:true}, body:{...}, header:{...} }，
  // 可以直接用 im.message.create / patch_card / 写 .card 文件等所有标准发送路径。
  console.log(JSON.stringify(dsl, null, 2));
}
```

## 已覆盖的元素 / 字段

读端转换（raw → 公开 DSL）已对照真实归档对齐过的：

- **结构**：body / column_set / column / hr
- **文本**：markdown（含 plain_text / br / list / heading / blockquote / link / code_span / code_block / text_tag / at_all 子元素的 inline 还原）
- **媒体**：img（`imageID` 还原为 `img_key`、`width_height_pixels` size_value 还原为 `"Wpx Hpx"`、`aspect_ratio` 还原为 `"W:H"`）
- **header**：title / subtitle / template / padding / udIcon → standard_icon
- **互动**：button（`actionType:"link"` → `multi_url`，`actionType:"multi"` → `behaviors[]`，`action_request` callback 丢弃）、interactive_container
- **图表**：chart（`chart_spec` 子树原样保留 camelCase）
- **数据视图**：person（`userID` → `user_id`，`pillShaped` 丢弃）、input（白名单字段，editor-only 字段全丢）
- **可折叠面板**：collapsible_panel（header 的 raw 端 layout 残留 position/width/vertical_align 全丢）
- **配置**：config 强制输出 `{update_multi: true}`（cardkit 发送链路要求）
- **box 字段**：padding / margin / corner_radius / icon size 全部从对象形态转回字符串

## 已知限制

- 转换器只管"读端"：把 raw envelope 项目回公开 DSL。**不**反向：从公开 DSL 生成 raw envelope。
- 罕见 element（table、form 嵌套等）只走 generic 递归 + camelCase→snake_case，没专门处理。如果遇到飞书校验失败的字段，欢迎 issue / PR。
- `action_request` 类型的按钮 callback（cardkit entity 层的概念）在公开 DSL 里没有对应表达，会被丢弃。

## 开发

```bash
pnpm install
pnpm test           # vitest 单测
pnpm build          # 输出 dist/
```

测试基于真实 raw envelope fixture（`tests/fixtures/*.raw.json`），覆盖 padding / img / markdown / chart / person / input / button / header 各路径。

## License

MIT

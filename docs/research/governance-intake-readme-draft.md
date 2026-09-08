<!-- 草稿。reference：可參考，不是 current truth。落地位置：packages/workflow-engine/src/modules/governance-intake/README.md（Phase C 第 7 步）。 -->

# Governance Intake

日期：2026-09-05　基準：jigwright-package-side @ 375ddf8　狀態：手寫初稿；依計畫 §3 最終只留「為什麼」一段手寫，其餘四段改生成（Phase C 第 7 步）

想法、問題、需求怎麼進入系統，以及進來之後誰有權威。這個 module 管三種記錄：**Source**、**Finding**、**Work Item**。

契約在 [`openspec/specs/governance-intake/spec.md`](../../../../../openspec/specs/governance-intake/spec.md)；本頁只講「這是什麼、為什麼這樣設計、怎麼用」，不重述任何 SHALL。

> 本頁的設計說明是 agent 依 owner 討論整理的解讀（agent-derived）。owner 原話的權威在 Source ledger，不在這裡。

---

## 這是什麼、為什麼這樣設計

### 三種記錄，三個問題

| 記錄 | 回答的問題 | 重量 | 住在哪 |
|---|---|---|---|
| **Source** | owner 說了什麼——**核心需求**，逐字 | 少而重。不可改，只能被新的 Source 取代 | `workflow/source-ledger/objects/sha256/` |
| **Work Item** | 有一件**要做的事** | 有狀態，會往前走 | `docs/work-registry/items/<year>/WORK-<ULID>.yaml` |
| **Finding** | task 進行中發現的**觀察**，還沒決定要不要處理 | 多而輕。有日期、算推測 | `.git/workflow-engine/findings/`（見「已知限制」） |

分辨的口訣：**Source 是「要照著做的話」，Finding 是「要去查的話」。** 要做的事一律是 Work Item。

### 四個設計原則

1. **「誰說的」和「是需求還是問題」是兩件事。** 作者是 Source 的欄位（`maintainer` / `agent`）；種類是 Work Item 的 `kind`（`bug` / `feature` …）。一句話不會因為是 bug 就進 Finding，也不會因為是 owner 說的就進 Source。
2. **Source 只放核心需求。** 隨口一提的觀察不鑄 Source。一筆 Work Item 可以零個 Source（純 bug），也可以多個（需求加補充）。
3. **inbox 是預設入口。** 不管有沒有進行中的 change，新的事預設先進 `inbox`；唯一的例外是 `now`，需求明確到現在就做時可以直接開 change，`origin.json` 引用 Source，不必為了儀式先建 Work Item。Finding 不是另一個入口，是 task 內的暫存區：task 中的 agent 只能改 `allowedPaths` 裡的檔案，觀察不該混進 task 的 diff，所以先放在 worktree 外，事後沖進 inbox。
4. **agent 轉錄，人過目。** owner 不親手下指令，所有 Source 都由 agent 逐字轉錄。引擎選擇相信 agent：每筆 Work Item 一開始是 `agent-derived`，**inbox 的意思就是「agent 記了，owner 還沒看」**；`inbox → backlog` 的 review 是 owner 過目的地方，過了才變 `maintainer-confirmed`。轉錄錯了，修法是 supersede 一筆新 Source，舊的留著當歷史。

agent 唯一要守的規矩：**逐字，不改寫；自己的觀察標 `agent`，owner 的話標 `maintainer`。** 引擎不檢查這件事，這是設計選擇，不是漏洞。

### 權威到哪裡為止

Source 對「這件工作是什麼意思」有最高解釋權，但**沒有** lifecycle、priority、或 transition 的權威。它不能繞過 spec、policy、check、或 Grant。一句 owner 原話可以決定 change 該做什麼，不能決定它可以跳過 review。

### 生命週期

```
                 owner 需求 ──later / now──▶ Source ──┐
                                                       ├─▶ Work Item ──▶ change origin.json
agent 在 task 中的觀察 ──finding add──▶ Finding ──convert──┘        （sourceRefs 引用 Source，不複製文字）

Work Item stage:  inbox ──review accept──▶ backlog ──promote──▶ active ──archive──▶ closed
Finding disposition:  pending ──▶ converted | linked | dismissed
```

每個箭頭是一個決定：
- Finding → inbox：「這值得登記成一件工作嗎？」（convert / link / dismiss）
- inbox → backlog：「確定要做嗎？」（accept；prioritize 另設 lane）
- backlog → active：promote，原子連結 Work Item ↔ `origin.json` ↔ Sources
- active → closed：archive 決定性關閉，Source 與 timeline 保留

---

## 目前有哪些

<!-- 待生成：以下應由 registry 印出，目前手寫 -->

**Work Item 三個獨立欄位**

| 欄位 | 值 | 意思 |
|---|---|---|
| `kind` | `feature` `bug` `improvement` `chore` `research` | 是什麼 |
| `stage` | `inbox` `backlog` `active` `closed` | 進行到哪 |
| `lane` | `now` `next` `later` `icebox` `null` | 多急 |

**受治理的 transition**：`intake`（inbox → backlog）、`prioritize`、`promote`。每個可設 `ordinary` 或 `central-grant`；`workflow/work-registry-policy.json` 不存在時全部是 `ordinary`，不碰 Grant。

**Source 作者**：`maintainer` 必須配 `direct-human:` 或 `maintainer-confirmation:` 開頭的 contextRef；`agent` 不得把自己的轉述標成 maintainer。

---

## 對外表面

**組合動詞**（一句話、給 agent 用）

| 動詞 | 做什麼 | 注意 |
|---|---|---|
| `now "<原話>"` | 鑄 Source，直接開 change | 需求，現在就做 |
| `now <work-item-id>` | promote 既有 Work Item 成 change | 有 agent Source 時強制 symbol survey |
| `later "<原話>"` | 鑄 Source，建 inbox Work Item | 需求，之後做。**觀察不要走這條**（會誤鑄 Source） |
| `attach <work-item-id> "<原話>"` | 鑄 Source，掛到既有 Work Item | 補充，不改 stage / lane |

**窄入口**（結構化 envelope）

| 動詞 | 做什麼 |
|---|---|
| `source capture --input` / `show` / `list` / `trace` / `link-change` | Source 的建立與追溯 |
| `work-item create --input` / `review --input` / `promote-prepare` / `promote` | 建立、分診、升級 |
| `work-item list` / `show` / `search` / `trace` / `render` / `validate` / `inventory` / `recommend` | 讀取與投影 |
| `finding add` / `list` / `show` / `convert [--now]` / `link` / `dismiss` | 暫存區與處置 |

**讀寫的檔案**

| 路徑 | 誰擁有 |
|---|---|
| `workflow/source-ledger/objects/sha256/**` | 引擎，append-only，位置固定不可設定 |
| `docs/work-registry/items/<year>/*.yaml` | 引擎寫、人可讀，一 item 一檔 |
| `docs/work-registry/inventory.json` | 生成 |
| `docs/BACKLOG.md` | 生成（`work-item render`），只印 current rows |
| `docs/work-history/<year>.md` | 生成，closed 的歷史；還沒有 closed item 所以尚未出現 |
| `workflow/repository-consumer.json` | 四個路徑可覆蓋，省略即上述預設 |
| `workflow/work-registry-policy.json` | 選填；三個 transition 的 `ordinary` / `central-grant` |
| `.git/workflow-engine/findings/` | Finding 暫存區，不進 repo |

CLI 路由在 [`entrypoints/cli/governance-intake-cli.ts`](../../entrypoints/cli/governance-intake-cli.ts)；finalize 之後的 nextSteps 會提醒 pending Finding 數量，那段在 `modules/guidance/`。

---

## 契約

<!-- 待生成：requirement 標題應由 spec 反查印出 -->

`openspec/specs/governance-intake/spec.md`，22 條 requirement，分五群：

- **Source 不可竄改**：Preserve Selected Wording Exactly · Corrections Preserve Earlier Sources · Source Trace Exposes Provenance Without Copying Authority · Every Governance Citation Resolves · Ledger Path Is Engine-Owned
- **Work Registry**：Stable Per-Item Records · Reviewed Decisions Use Grant Core · Promotion Atomically Links Work and Source Provenance · Read Surfaces Are Deterministic · Search Resolves Linked Source Wording · Always Available; Use Is Not Mandatory · Archive Reconciles Linked Work Items
- **Finding**：Remain Independent of Task Write Scope · Disposition Is Append-Only · Conversion Has One Deterministic Target · Link Is a Receipt-Only Relation
- **意圖層動詞**：Now Starts One Source-Bound Change · Now Promotes One Eligible Work Item · Later Surface Is One Command · Attach Adds a Source Without Reclassifying Work
- **下游**：Planning Prose Distinguishes Source-Backed Claims · Intake Counts Are Read-Only

---

## 決策與原話

<!-- 待生成：D-id 由 DECISION-REGISTER 反查；Source 印原文 -->

- **D-018**（owner 2026-09-02）—— Work Registry 永遠內建；Work Item 使用不強制。
- **D-019**（owner 2026-09-02）—— 意圖層動詞命名 `now` / `later` / `attach`；Finding 加單一 `disposition` 欄位與三個動詞；finalize 時 triage 掛在 nextSteps，不阻塞。
- **T3 v3 §3.5** —— 兩條窄入口、Finding 不受 task allowedPaths 限制、落地可為 journal 或 dedicated ref。

上面「四個設計原則」來自 owner 2026-09-05 的討論，**尚未捕捉為 Source**。捕捉後本節應改為引用並印出原話。

---

## 程式碼

<!-- 待生成：freshness 徽章來自 ledger binding -->

| 檔案 | 責任 |
|---|---|
| [`governance-intake.ts`](./governance-intake.ts) | Source 與 Finding 的不可變基底：content-addressed 捕捉、supersede 鏈、Finding 的 append-only disposition。每次讀取重算 digest，漂移即拒讀 |
| [`work-registry.ts`](./work-registry.ts) | Work Item 的 canonical YAML、stage / lane / kind、review 與 promotion 的原子交易、BACKLOG 與 inventory 投影 |
| [`work-registry-grant.ts`](./work-registry-grant.ts) | 當 policy 把 review 或 promote 設成 `central-grant` 時，產生對 Grant Core 的 transition 請求 |
| [`intake-summary.ts`](./intake-summary.ts) | 唯讀的計數（inbox、pending Finding、backlog），給 guidance 的 nextSteps 用，不建任何記錄 |

`work-registry.ts` 有 5,381 行，是本 module 九成的重量。

### 邊界

三種記錄的操作都在這個目錄，但有四樣東西在外面：

| 在外面的 | 位置 |
|---|---|
| Source 的記錄格式與作者規則（`maintainer` 需 `direct-human:` contextRef） | `packages/core/src/governance-source.ts` |
| Work Registry 四個路徑的預設值 | `modules/repository-consumer/repository-consumer-config.ts` |
| `now` / `later` / `attach` 與所有 CLI 路由 | `entrypoints/cli/governance-intake-cli.ts` |
| finalize 後提醒 pending Finding 的 nextSteps | `modules/guidance/` |

review 或 promote 被 policy 設成 `central-grant` 時，簽核走 `modules/authority`（Grant Core）；本 module 只產生請求。

`docs/BACKLOG.md` 不是第四種記錄，是 Work Item 的投影，每次 `work-item render` 重算。

---

## 已知限制

- **Finding 不跟著 repo。** 存在 `.git`，clone 就消失。T3 允許的另一個落地方式是 dedicated git ref，尚未做。
- **沒有「更正」動詞。** 四個組合動詞全部寫死 `supersedes: null`；更正只能用 `source capture --input` 手填。
- **`later --kind bug` 已不鑄 Source**（f5b1f36），但 BACKLOG 仍不印 kind，分不出觀察與需求。
- **BACKLOG.md 不印原話、不印 kind、不分組。** owner 要過目 Source 內容得另外 `source show`。

情境對照與缺口清單見 [`docs/research/intake-use-cases.md`](../../../../../docs/research/intake-use-cases.md)。

---

## 驗證入口

```bash
pnpm workflow work-item validate --json      # registry 每筆記錄與 inventory 一致
pnpm workflow source list --json             # 所有 Source，含 supersede 鏈
pnpm workflow source trace <SRC-id> --json   # Source → Work Item → change → archive
pnpm workflow work-item trace <WORK-id> --json
pnpm workflow finding list --json            # 預設只列 pending
```

雜湊只出現在這些指令的輸出裡，不出現在本頁正文。

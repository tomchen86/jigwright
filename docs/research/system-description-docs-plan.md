<!-- Proposal memo. Reference only under workflow document policy: it may inform work but is never current truth. Captured wording lives in the Governance Source ledger; this memo is the agent-derived interpretation. -->

# Jigwright 系統描述文件架構計畫

日期：2026-09-02　基準：jigwright-package-side @ f759e6c　狀態：提案；排程為 Phase A 前置 → Phase B real pilot → Phase C 本功能（§6）；待 owner 決定 §9

## 0. 目標與原則

**目標**：人能讀懂整個系統；agent 找得到該讀的、忘不掉該更新的；任何 repo 結構零設定可用。

1. **Docs live with code**：樹就是地圖，root → package → module → file。跨 module 概念放最低共同祖先。
2. **能生成的一律生成**：人只寫「這是什麼、為什麼」。清單類內容（方法、grant 種類、CLI、設定）從 registry 印。
3. **原話不可改，只被 supersede**：下游只引用 id，永不複製原文進 canonical record。
4. **人與 agent 共用同一份可讀文件**：agent 用意義推理，engine 用位元組驗證。投影裡 SRC 印原話、WORK 印標題、capability 印標題；雜湊只在驗證指令內流動，agent 不直接讀雜湊。要查時效或歷史時才下指令（`source trace`、`documents validate`、`semantic-ledger show`）。
5. **閘門 fail-grant**：缺處置產生精確 challenge，不是 dead end（R-000）。
6. **每段解釋帶 `actor-attested` 與確認 commit**：engine 不宣稱驗證過理解。
7. **解釋住在檔頭，index 住在 ledger**：責任、不變量、依賴寫在 src 檔頭，任何時候打開檔案就讀到，不只正式 investigation 才看見。ledger 只存 binding 與 freshness；DAG 從檔頭的 Depends on 推導，不另外撰寫。

## 1. 現況（f759e6c 實測）

| 機制                                           | 狀態                                                                   | 缺口                                                                               |
| ---------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Source ledger `workflow/source-ledger/`        | 機制完整（D-018/D-019）                                                | 三個 repo 零筆；backlog 只印 SRC id                                                |
| Work Registry、Finding、`now`/`later`/`attach` | 完整                                                                   | BACKLOG enforcement 仍 `planned`                                                   |
| Semantic Ledger `workflow/semantic-ledger/`    | 程式碼已移植（D-017），本 repo 從未執行                                | 零筆；無 list/show/render；只 `file` 粒度                                          |
| src 檔頭註解                                   | 存在者品質高（provider-registry、path-role-registry、semantic-ledger） | 459 個 src 檔只有 33 個有；authority 1/39；JSON 設定檔無處可放                     |
| Investigation WHY overlay → design.md 區塊     | 程式碼已移植，本 repo 從未執行                                         | 唯一範例是舊 engine 產出、逐位元組搬來的歷史（舊 flat src/ 佈局）；投影 80% 是雜湊 |
| `openspec/specs/` 23 capability                | normative、delta enforcement                                           | 無 `owns`、無 `sources`、無反向影響閘門、flat                                      |
| `document-policy.json`                         | modes、validate、refresh                                               | 沒有 module README 條目                                                            |
| DECISION-REGISTER                              | 好讀，維持                                                             | R-001..R-014 只在 quarry；R-000 是 AGENTS.md prose                                 |
| ARCHITECTURE.md                                | 15 行                                                                  | 沒有系統敘事                                                                       |
| consumer `shared-expense-tracker`              |                                                                        | 無 R-000；document-policy 指 ISSUE_LOG；path-roles 是 engine 路徑                  |

**關鍵事實**：現行 engine repo 465 個 commit（08-25 到 09-02）零個帶 `Change:` trailer；21 個 archived change 全是 08-24 clean-slate 前的搬運歷史；唯一的 planning draft `complete-current-only-release-candidate`（08-29，base 21fa991）從未走到 managed commit，且 base 已落後 HEAD。engine 還沒有 dogfood 過自己。上表所有「機制完整」都是程式碼層面的，不是執行層面的。

結論：provenance chain 在 Source → Work Item → change → archive 的設計完整；spec 層與解釋層是孤島。缺的是一次真實執行、資料、兩個宣告、一個閘門、一個人讀出口。

## 2. 目標結構

```
<repo>/
├─ README.md                          系統敘事：一個 change 的一生、module 各一句     人寫
├─ docs/
│  ├─ DECISION-REGISTER.md            D/S/O 人寫；Source records 與 quotations 生成
│  ├─ REQUIREMENTS.md                 原話視圖：R-id、原文、日期、落到哪、狀態      生成
│  ├─ SPEC_MAP.md                     capability 依 owns 頂層目錄分組 + 一行摘要     生成
│  └─ COVERAGE.md                     無 spec 的原話、無 owner 目錄、無 entry 檔案   生成
├─ packages/<pkg>/
│  ├─ README.md                       package 是什麼、分工                           人寫 + 生成段落
│  └─ src/modules/<module>/
│     ├─ README.md                    見 §3                                          人寫 + 生成段落
│     ├─ spec.md（可選，§6 第 10 步）  契約，給閘門讀
│     └─ *.ts                         檔頭 = 責任、不變量、依賴的家（§3a）
├─ openspec/specs/<capability>/spec.md  現行位置不動，加 owns / sources
├─ openspec/changes/                  集中，不動
└─ workflow/{source-ledger,semantic-ledger}/  source = 原話；semantic = 檔頭的 binding 與 freshness index，不存文字
```

## 3. Module README 的段落與來源

| 段落                                           | 誰寫               | 來源                                                                                       |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------ |
| 這是什麼、為什麼這樣設計                       | 人                 | `document-refresh` reviewed-section；骨架變了標 stale                                      |
| 目前有哪些（grant 種類、provider family…）     | 生成               | 該 module 的 registry（如 `grant-transition-registry`）                                    |
| 對外表面：CLI 動詞、讀取的 `workflow/*.json`   | 生成               | cli 路由、import                                                                           |
| 契約                                           | 生成               | `owns` 反查 capability → requirement 標題各一行                                            |
| 決策與原話                                     | 生成               | DECISION-REGISTER 中提到的 D-id；Source 印原文                                             |
| 程式碼：每檔責任、不變量、依賴、freshness 徽章 | 檔頭人寫；徽章生成 | 機械抽取檔頭的 Invariants / Depends on；freshness 來自 ledger binding；無檔頭列入 COVERAGE |
| 驗證入口                                       | 生成               | 文件尾端列出對應驗證指令；雜湊只出現在指令輸出，不出現在正文                               |

範例（無雜湊）：

```
### grant-core.ts                          current · claude · 確認於 a3d9a82 · actor-attested
責任：Grant Core 唯一的授權邊界；所有 protected transition 從這裡拿 exact grant。
不變量：接受 grant 後不得再加第二道否決；grant 綁定 subject digest。
依賴：grant-transition-registry.ts、grant-policy.ts
### grant-transition-registry.ts           dependency-changed · 需重新確認
```

### 3a. 檔頭格式（解釋的家）

```ts
/**
 * Grant Core：protected transition 唯一的授權邊界。
 *
 * Invariants:
 * - Grant Core 接受 exact grant 之後，不得再加第二道安全否決。
 * - grant 綁定 subject digest；subject 變則 grant 失效。
 *
 * Depends on: grant-transition-registry.ts, grant-policy.ts
 * Failure modes: 被 revoke 的 grant 被 replay；grant 套在漂移後的 subject 上。
 */
```

- 15 行內：責任一句、Invariants、Depends on、Failure modes。更長的說明放 module README。
- engine 機械抽取三個標籤段落，做法同 declared-path-symbols：lexical、淺、誠實。沒有標籤的散文也合法，只是不產生 DAG 邊。
- reviewer question 與 answer 是 per-change 證據，留在 investigation manifest，不進檔頭。investigation 的 why / protectedInvariant 欄位從檔頭預填：agent 讀檔頭後確認或修正，修正必須改檔頭。
- JSON 設定檔沒有註解，`workflow/*.json` 八個檔案零個 description 欄位；它們的解釋放 owning module 的 README。

## 4. 兩個新宣告

- capability 標頭 `owns: [globs]`：沿用 mutation-class-policy 的 selector 語法與 digest 綁定。ownership 只存在這裡，不做第二份真相。
- requirement `sources: [SRC-…]`：把原話接到 normative 層。
- validator 併入 openspec-base-spec-validity：懸空 SRC、重疊 owns、無主目錄、無 sources 的 requirement。

任何檔案的 governing set = owns 命中的 capability + package/root 的 system spec。這就是「父 folder 的 docs」，由宣告推導，consumer 不需遵守 src 慣例。

## 5. 兩個注入／閘門點

- **open-task**：`guard.json` allowedPaths ∩ owns → governing capabilities、其 delta 是否已存在、相關 ledger entry 的 freshness。印在既有 intakeCounts 旁。注入的是 render 過的 prose（摘要、requirement 標題、責任與不變量），不是 manifest JSON 或 id 清單。
- **finalize**：實際 diff ∩ owns → impacted capabilities。每個需要一個處置：`delta`、`no-impact <reason>`、`later`。`later` 呼叫既有動詞，把「忘了更新文件」變成 inbox Work Item。缺處置 = 一個 Fail-Grant challenge。同時重印受影響 README 的生成段落；curated 段落骨架變了標 stale。檔頭層級同理：code 改了但檔頭 digest 沒變 → 處置 `confirm`（重讀仍為真，寫新 binding）、改檔頭、或 `later`；Depends on 指到的檔案改了 → 該檔頭標 dependency-changed，直到 confirm。

## 6. 交付順序

### Phase A：pilot 前置（現在，純設定與寫作，不改 engine）

- **consumer 設定修正**（原第 8 步提前）：`path-roles.json` 目前全是 engine 路徑，consumer 的 `apps/**` 會全部落成 `unregistered`，path-role 是 fail-deep，等於 investigation 成本最大化；`document-policy.json` 仍指 `docs/issues/issues.yaml`，engine 已移除 ISSUE_LOG，`documents validate` 可能直接失敗；AGENTS.md 補 R-000。
- **root README**：engine 與 consumer 各一頁系統敘事。pilot 的 agent 需要它，寫作成本約一小時。
- **檔頭**：只寫 pilot 會碰到的 module，不做 13 個 module 的 baseline。

### Phase B：real pilot（一個真實的 consumer change，開著 ledger 跑）

- 從 consumer roadmap 挑一個小而真實的 change。
- 原話用 `later` 或 `now` 進 Source ledger，不手寫 envelope。
- 走完 propose → investigation → open-task → finalize → archive，讓 WHY row、semantic ledger、backlog、handoff 自然產生。
- 每個摩擦點用 `finding add` 記錄，不寫在聊天裡；pilot 結束時 `finding list` 就是本功能的真實 backlog。
- 出口條件：一個 change 在 consumer 上以 managed path 歸檔；至少一筆 Source、一筆 WHY row、一筆 ledger entry 存在；用真實資料回答「backlog、handoff、design.md 人讀得懂嗎」。

### Phase C：本功能（pilot 之後，依 Finding 重排以下順序）

0. **Dogfood**：先處理 stale 的 planning draft（abort 或 rebase 到 HEAD），然後把第 1 步當成 engine 在本 repo 的第一個完整 managed change：propose → investigation → open-task → finalize → archive。這一步驗證 DAG 會不會長、design.md 區塊長什麼樣、fail-grant 閘門是否如 R-000 所述。在此之前，§1 的每個「已有」都只是設計。
1. **原話進 ledger**：R-000..R-014 以 direct-human provenance capture；R-id 作 alias；DECISION-REGISTER 的 Source records 與 quotations 改生成。
2. **決策 D-020**：人讀投影可引用 Source 與 ledger 文字；非 authority，`documents validate` 拒漂移。
3. **owns / sources 宣告 + validator**（§4）。
4. **生成器 v1**：SPEC_MAP、COVERAGE、REQUIREMENTS 視圖，走 document-policy `generated`。
5. **檔頭 baseline**：為 13 個 module 的 load-bearing 檔案寫檔頭（§3a 格式）。現況 459 個 src 檔只有 33 個有檔頭、authority 1/39，這是真實的寫作成本；但不需要新工具就能開始，寫完立刻對每個打開檔案的 agent 生效。engine 隨後從檔頭抽取並寫 binding（blob digest、header digest、depends、author、commit）；ledger 從此有資料但不存文字。
6. **Module README renderer**（§3）+ document-policy 條目。第一頁 = `modules/authority/README.md`（Grant Core）。驗收 = §7 Q1。
7. **open-task 注入 + finalize spec-impact gate**（§5）。
8. **consumer 補課**：R-000 由 engine 投影進 AGENTS.md；document-policy 移除 ISSUE_LOG；path-roles 改為 `apps/`。
9. **baseline reconciliation**：清 stale requirement。必須在第 7 步之後，否則清完再漂。
10. **可選、之後再議**：spec.md 搬到 code 旁；semantic subject 細化到 symbol。

## 6b. 新 consumer 的套用方法：`jigwright init` / `doctor` / `upgrade`

現況：打包後的單一 package 有 `jigwright init`，但它只寫 `workflow/jigwright-profile.json`（D-006 的 ordinary floor profile，已存在即拒絕重寫），不建 policy、schemas、openspec config 或 docs；monorepo 的 `pnpm workflow` 沒有對應動詞。新 consumer 其餘仍靠手工複製，shared-expense-tracker 的 engine 路徑殘留就是手工複製的產物。

原則：**engine 出機制與預設，consumer 只持有內容**。比照 D-018「省略 `workRegistry` 即採 engine 預設」，init 寫最少的檔案，其餘預設留在 engine 內部，consumer 要覆蓋才落地成檔。

| 層                             | 內容                                                                                                                                                                                                   | 誰擁有             | init 做什麼                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------- |
| 1 engine 擁有、生成、禁止手編  | `workflow/schemas/**`、`workflow/openspec-assets/**`、skills 與 prompts、`openspec/config.yaml`、AGENTS.md 的 engine doctrine 段（R-000 投影）、`docs/WORKFLOW.md`、`docs/DOCUMENT_STRUCTURE_GUIDE.md` | engine，隨版本重生 | 寫入，帶版本與 digest 標記                                           |
| 2 engine 預設、consumer 可覆蓋 | `workflow/*.json` policies：document-policy、checks、ci-policy、grant-policy（依 D-005 預設關閉）、role-provider-default、ai-adapter-policy、test-shards                                               | engine 預設        | **不寫檔**；只寫 `repository-consumer.json` 身分檔；覆蓋時才生成該檔 |
| 3 consumer 內容                | `path-roles.json`（空登記，unregistered 即 fail-deep）、`openspec/specs/**`、`owns` 宣告、ROADMAP、原話（`later`/`now`）、module README 人寫段、檔頭                                                   | consumer           | 建空殼；COVERAGE 列出缺什麼；閘門只問碰到的目錄                      |
| 4 投影                         | BACKLOG、handoff、SPEC_MAP、REQUIREMENTS、COVERAGE、root README 的生成段                                                                                                                               | engine 生成        | 首次 render 時建立，永不手編                                         |

- `doctor` 加 adoption 檢查：缺第 1 層檔案、第 1 層 digest 漂移、第 2 層覆蓋檔與預設的差異、engine 路徑殘留（正是 consumer 現在的 bug）、document-policy 引用已移除的 validator。
- `upgrade`：engine 版本升級時重生第 1 層、對第 2 層覆蓋檔報差異、不碰第 3 層。
- Phase A 的 consumer 設定修正這次手工做，但每一步記成 init 的 spec；Phase A 就是 init 的 dry-run。
- 現行 `docs/WORKFLOW.md` 與 `DOCUMENT_STRUCTURE_GUIDE.md` 在 document-policy 是 `curated`，但內容是 engine 版本相關的，應改為第 1 層生成；consumer 那份 guide 日期 07-16，已經在講 ISSUE_LOG。

## 7. 驗收

- Q1「grant module 有哪些方法」：`modules/authority/README.md`，30 秒內。
- Q2「provider 怎麼註冊」：`modules/provider-orchestration/README.md`。
- Q3「整個系統怎麼運作」：root README 一頁。
- 改 `grant-core.ts` 不動 README 與 spec → finalize 出 challenge，選項含 `later`；不是 hard fail。
- 改 `grant-core.ts` → 依賴它的 README 段落自動變 `dependency-changed`。
- 所有人讀文件無 sha256。每段解釋帶 actor-attested 與 commit。
- consumer repo 只加 owns 宣告即可用，不改目錄結構。
- 新 consumer：`jigwright init` 後 `doctor` 全綠，只多出身分檔、空 path-roles、空 specs 目錄與第 1 層檔案；不需要複製任何 JSON。

## 8. 明確不做

- 不手寫任何清單；不做 owns 以外的 ownership 真相。
- 不強制每個目錄有 spec；不把 SHALL 契約改寫成散文，人從 README 進入。
- 不做 Finding 狀態機、UI、自動 triage（D-019）。
- 不提高任何安全分類、不新增 non-grantable 類別、不新增儀式（R-000）。
- 不刪 design.md 的 investigation-ledger 區塊，它是證據，不是人讀出口。

## 9. 待 owner 決定

1. D-020：人讀投影引用原文，是否接受。
2. `openspec/config.yaml` 的「grant-required paths fail closed when unavailable」與 R-000 的關係，需 explicit disposition。
3. 第 5 步 baseline 範圍：13 個 module 全做，或先做 authority 與 provider-orchestration。
4. 第 10 步是否要 symbol 粒度、是否搬 spec.md。
5. design.md 的 investigation-ledger 區塊改為 prose 加一行驗證指令，結構化證據留在 manifest。這是既有 requirement「Design Ledger Is an Engine-Managed Projection」的 MODIFIED，需要 delta。
6. CLI 非 `--json` 的預設輸出目前是 JSON dump（`printSuccess`），依原則 4 應改為 prose 與 next steps；`--json` 留給 engine 與 script。
7. SRC 與 FND 的 sha256 id 需要人類 alias（R-xxx 或短 slug），比照 Work Item 的 `aliases` 欄位；agent 在指令裡複製 id，不讀 digest。
8. Pilot 標的：從 consumer roadmap 挑哪一個 change；Phase C 的順序以 pilot Finding 重排後再定。
9. `init` 的最小檔案集：是否接受「第 2 層不落地、預設留在 engine」。
10. Semantic Ledger 改為 binding 與 freshness index、文字住在檔頭：既有 requirement「Reusable Knowledge Remains Separate From Per-Change WHY」需 MODIFIED，graph 擁有 binding 與 freshness，檔頭擁有 meaning。

## 10. 執行紀錄 2026-09-03（Phase A，直接修改、分段 commit）

**consumer `shared-expense-tracker`，分支 `work/pilot-prerequisites`**

Commits（hooks 全過）：66c394a8 install fix → a2ec4605 path roles → f3dda36c document policy → 30163687 R-000 → 376c0124 README。Engine：959ddbd README（分支 `work/complete-current-only-release-candidate`）。

- 發現並修復 pilot 硬阻塞：vendored jigwright 的兩個 `optionalDependencies`（grants、github-adapter）被 pnpm 11 link 成 `.tgz` 檔本身，`pnpm workflow` 每次都在 pre-run install 撞 ENOTDIR，`jigwright` bin 從未 link 上、`@fission-ai/openspec` 也沒裝好。修法：改為明確 devDependencies。修後 `pnpm workflow doctor` 全綠。
- `workflow/path-roles.json`：engine 路徑換成 consumer 自己的分類（44 條）；API services/modules 除 auth、sync 外刻意不登記。
- `workflow/document-policy.json`：移除兩個不存在檔案的條目；ISSUE_LOG 改 `reference`。兩個 engine 版本皆有效。
- `AGENTS.md`：逐字帶入 R-000。
- `README.md`：加「Working with Jigwright」。
- 驗證：sandbox 解壓 0.1.0 六個 tgz 直接用 node 跑，`documents validate` 與 path-role parser 通過；prettier 通過。

**engine `jigwright-package-side`**

- `README.md`：系統敘事（用途、change 的一生、where things live、layout、12 個 module 各一行、今日的採用方式）。

**未做、待決**

- 檔頭 baseline：pilot 標的未選，未寫。
- vendored 0.1.0（engine b1fb782，08-25）沒有 `later`/`now`/`attach`；HEAD 的 `repository-consumer.json` 語意與 0.1.0 互斥（`documents` 只准兩個 key、禁 `sourceRoot`）。刷新 vendor 後要套的變更寫在 `consumer-config-after-revendor.md`。
- Node 25.9 vs release matrix `>=22.22.1 <23`：目前能跑，但 pilot 前應對齊。

<!-- Proposal memo. Reference only under workflow document policy: it may inform work but is never current truth. Captured wording lives in the Governance Source ledger; this memo is the agent-derived interpretation. -->

# Jigwright 系統描述文件架構計畫 v2

日期：2026-09-05（v2.1）　基準：jigwright-package-side @ 1c4cf5e（`work/pilot-findings-fixes`，分支仍在動）　狀態：提案 v2.1，§9 已全部裁決；待覆蓋進 docs/research 並 commit
前版：2026-09-02 @ f759e6c。v2 依 pilot 實測與 09-04～09-05 的討論改寫：§1 全部換成實測值、§5b/§5c 新增、§6 順序重排、§9 全部裁決、§11 新增 drift。v2.1（同日）加 §0.9 機械優先：spec 搬進 module 目錄、ownership 用包含關係、檔頭縮成兩段且不變量以檔頭為主、README 只剩一段手寫、依賴不住任何文件。

## 0. 目標與原則

**中心思想（owner 2026-09-05）**：只有一個權威，很多地方都看得到。人和 agent 讀到的永遠是文字，不是 id、不是雜湊。投影是達成這件事的手段，不是例外。所有文件都從這一句推出來。

**目標**：人能讀懂整個系統；agent 找得到該讀的、忘不掉該更新的；任何 JS repo 零設定可用（跨語言為後續目標，見 §6b）。

1. **Docs live with code**：樹就是地圖，root → package → module → file。
2. **能生成的一律生成**：人只寫「這是什麼、為什麼」。
3. **原話不可改，只被 supersede**：下游只引用 id，永不複製原文進 canonical record。生成的投影可以印原話。不可改只適用 maintainer Source；agent 寫的 Source 是重量錯誤，轉成 Finding 後刪除（owner 09-08）。
4. **人與 agent 共用同一份可讀文件**：投影裡印原話、印標題，不印 SRC/FND/WORK 的 id；id 與雜湊只在驗證指令內流動。BACKLOG、README、AGENTS.md 的 R-000 段都是投影，ledger 是唯一權威。
5. **閘門 fail-grant**：缺處置產生精確 challenge，不是 dead end（R-000）。
6. **解釋帶確認 commit，不帶作者**：解釋的權威靠追溯（§5b），不靠署名。
7. **解釋住在檔頭，index 住在 ledger；DAG 從 import 推導。** 檔頭只淺讀 `Invariants:` 區塊，不設閘門。
8. **只有三種文件活得下來**：可執行、生成、有日期。手寫且宣稱「現在為真」的散文只允許 README 的「為什麼」段，而且要上閘門（§5c）。
9. **機械優先，降低 agent 心智負擔**：判斷只在宣告時做一次，不在每次 change 重做。能從程式碼算出來的（依賴、指令表、檔案表）永遠不手寫。腐爛的根源是忘記更新和沒查好就寫：前者用閘門，後者用「生成段先印、人對著事實寫」。

## 1. 現況（@1c4cf5e 實測，2026-09-05）

| 機制 | 實測 | 缺口 |
|---|---|---|
| Source ledger | 引擎 23 筆、consumer 1 筆；pilot 端到端驗證過 | 沒有「更正」動詞：四個組合動詞全寫死 `supersedes: null`。**R-000..R-014 不在 ledger**：R-000 是 `AGENTS.md` 第 3 行起的散文，consumer 有手抄複本；ledger 裡提到 R-000 的兩筆是 agent finding。DECISION-REGISTER 實際沒有引用 R-000（v1 §1 說每條 D 都引用 R-xxx，不成立） |
| Work Registry | 引擎 13 筆全在 inbox、無 lane；consumer 18 筆（17 inbox、1 backlog）有 lane。kind 用到 bug/feature/improvement/chore，`research` 無人用 | 沒人分診；已修好的六筆仍在 inbox |
| Finding | 兩個 repo 至今 0 筆。`finding add` 不再需要 open session（fe98b0b）；task 內的 `later` 會 stage 成 Finding（f5b1f36） | 仍存在 `.git/workflow-engine/findings`，clone 就消失 |
| 意圖動詞 | `now`/`later` 收 `--kind`；觀察類不鑄 Source；`finding convert` 不鑄 agent Source（f5b1f36） | 只回顯給 agent，人看不到 |
| Semantic Ledger | 兩個 repo 0 檔。寫入路徑在 reconciliation（`recordImplementationReconciliation`），pilot 沒走到 | 投影寫死 `semanticDependencies: []`——**邊永遠是空的**；planning 時期投影無人呼叫 |
| Freshness | `semantic-freshness.ts` 四種狀態的規則都在 | 沒邊，「依賴變了」永遠不觸發 |
| src 檔頭 | 425 個 `.ts`（engine+core），line-1 `/**` 只有 15 個，§3a 格式 2 個；authority 1/39 | **沒有任何東西讀檔頭**。三個 pin 是整檔雜湊，分不出檔頭改動 |
| `openspec/specs/` | 23 份；**0 份引用任何 src 路徑**；17 份 Purpose 是 TBD | 與程式碼零綁定；三套分類不對齊（23 spec / 13 module / 12 protected capability） |
| Module README | `packages/` 下 0 份 | |
| BACKLOG.md | 平列表，按 lane 再 id 排；印 id、標題、stage、lane、summary、SRC 連結 | 不印原話、不印 kind、不分組 |
| Finalize 範圍 | planning 掃所有 tracked 文字檔；finalize 的 `productionSourcePath` 排除 docs/、openspec/changes、scripts、tests；spec.md 與 `workflow/*.json` 只在 path-roles 登記時才算 | 投資雙向、守門單向 |
| 掃描 | 產物（coverage、lock、bundle）已排除出 content/symbol 掃描（0fd5921） | |
| `jigwright init` | 只寫 `workflow/jigwright-profile.json` | 其餘手抄；consumer schema 漂移（19 vs 14 檔，5 個已退役 validator）；`doctor` 寫死 `ok:true`；非 Node 結構性排除 |
| Pilot | 前半段（intake → investigation → PlanReview ×3）跑通，收 11+ finding；卡在 provider 格式違規 | **open-task、finalize、archive 零證據**；§5 兩個閘門無 pilot 證據 |

**關鍵事實**：架子蓋好了（schema、freshness、寫入路徑），裡面沒東西，架子之間沒有線。文件功能供給的正是缺的兩個輸入（import 邊、穩定的意義）和兩個消費者（open-task 注入、finalize 閘門）。分開做兩邊都做不完。

## 2. 目標結構

同 v1，改三點（09-05 v2.1）：**spec.md 搬進 module 目錄**，ownership 由包含關係決定，不宣告；scenario 加 `covers`（指向檔頭不變量）與 `test`；use case 探索文件住 `docs/research/intake-use-cases.md`（reference）。

```
packages/<pkg>/src/modules/<module>/
├─ spec.md      跨檔承諾 + scenario（covers、test、sources）
├─ README.md    手寫「為什麼」一段 + 生成段
└─ *.ts         檔頭 = 一句職責 + Invariants
```

跨 module 的概念放最低共同祖先（package 或 root 的 spec）。「依賴」不住在任何文件裡，要看時 `semantic-ledger show` 從 import 圖印。

## 3. Module README

README 只有**一段手寫**，其餘生成：

| 段 | 內容 | 來源 |
|---|---|---|
| 為什麼這樣設計 | 每段一個設計決定：決定了什麼、為什麼、排除了什麼，指回 SRC。「何時用哪個動詞」併入此段 | **手寫**；標「確認於 commit」，生成器印「此後本 module 改了 N 檔」 |
| 指令 | 動詞、參數、做什麼 | 生成：CLI 的 `Usage:` 字串；「做什麼」欄加進 usage 字串，跟程式碼一起改 |
| 資料 | kind / stage / lane 等列舉 | 生成：型別 union |
| 契約 | requirement 標題各一行連到 spec | 生成 |
| 檔案 | 每檔一行：檔頭第一句 + 不變量條數 | 生成：檔頭抽取器（§3a） |

裁決：第一頁 `modules/governance-intake/README.md`，第二頁 authority。2026-09-09 owner 驗收補課：增加 provider-orchestration README，補齊 §7 的 provider 註冊問題。

三份文件的分工，用「少了會怎樣」檢驗：spec 少了沒東西可強制、測試不知道保護哪條需求；README 少了「為什麼」只存在聊天裡、讀者要開四個檔才找到方法；檔頭少了 agent 改檔時看不到不變量。三者不可互相替代。不准放的東西：spec 不放為什麼與檔案清單；README 不放 SHALL 與單檔細節；檔頭不放規則、為什麼、依賴。

### 3a. 檔頭（v1：淺讀、不閘）

**兩段，不是四段**（09-05 v2.1）：一句職責、`Invariants:`。`Depends on` 與 `Failure modes` 砍掉——前者可機械算出（import），後者測試會講；手寫版本都是腐爛點。

```ts
/**
 * 意圖動詞：now / later / attach — 一句話進來，一筆 Source 加一筆 Work Item 出去。
 *
 * Invariants:
 * - [Governance Sources Preserve Selected Wording Exactly] 收到的 text 原樣寫入，不 trim、不正規化。
 * - later / attach 只裝 owner 的話；agent 自己的觀察走 Finding。
 */
```

- **不變量以檔頭為主**（owner 裁定）。規則機械：只牽涉這個檔案 → 檔頭；跨檔承諾 → spec。方括號可選，指向 spec 的 requirement 標題；有指就不重述句子。
- **淺抽取器（v1 就要）**：幾行 regex 抓 `Invariants:` 區塊。這是讀，不是閘門；README 檔案表與 spec 的 `covers` 都靠它。格式固定，寫錯抽不到。
- **免費的過期偵測**：`git blame` 比對檔頭區塊與程式碼最後修改的 commit，程式碼較新就標「可能過期」。不加機制。
- 回報要誠實：WHY 七欄裡檔頭最多退掉一個半。它做的是「不會不小心弄壞」，不是「不會忘記改」。

## 4. 三個宣告

- **ownership = 包含關係**（09-05 v2.1，取代 `owns` globs）：spec.md 住在哪個目錄就管哪個目錄。validator：有程式碼的 module 目錄必須有 spec.md，沒有就繼承上一層。`owns` 只留給極少數跨目錄例外。零宣告、零判斷。
- requirement `sources: [SRC-…]`：每條規則回答「為了哪一條需求」。
- scenario `covers: <file>#Invariants[n]`：指向檔頭的那條不變量（單檔者），或本 spec 的 requirement（跨檔者）。
- **scenario `test: <path>#<name>`（新）**：validator 檢查測試存在且通過。spec 變成證明的索引：**檔頭是句子的家，spec 是證明的家。**

```markdown
#### Scenario: 原字寫入
covers: governance-intake.ts#Invariants[1]
sources: [SRC-…]
test: governance-intake.integration.test.ts#exact-wording
```

validator 併入 openspec-base-spec-validity：懸空 SRC、無 spec 的 module 目錄、無 sources 的 requirement、無 test 的 scenario、`covers` 指向不存在的不變量、Purpose 為 TBD。

正典分類：**module 目錄為正典**（包含關係），23 份 spec 對齊到 13 個 module 是第 3 步的清理工作；protected-capability 回答「什麼需要 grant」，是政策不是描述，不參與。

## 5. 兩個閘門

同 v1。補兩點：

- **config.yaml 第 9 行「grant-required paths fail closed when unavailable」改為 Fail-Grant**（owner 裁定 09-05：R-000 為準，任何使用者不得走進死胡同）。
- finalize 的單向守門由包含關係補齊：module 目錄內任何 diff，finalize 問兩件事——spec 要 delta 嗎、README 的「為什麼」還成立嗎（處置：仍成立 / 已更新 / later）。這就是「忘記更新」的閘門，spec 與 README 共用。
- 檔案層的對應物是 ledger 的 `dependency-changed`：`grant-core.ts` 改了，沿 import 反向邊把依賴它的 entry 標 stale。spec 層用包含關係，檔案層用 import 邊，同一個「要處置」的模式、兩個粒度。

## 5b. Intake 模型（2026-09-05 裁決）

- **Source = 核心需求**，少而重，實作照原字做。**Finding = task 內的暫存區**，多而輕，事後沖進 inbox。**Work Item = 要做的事**，inbox 是正常入口，不管有沒有 active change。
- 「誰說的」和「需求還是問題」是兩件事：作者是記錄的欄位，種類是 Work Item 的 `kind`。隨口一提的 bug 不進 Source。
- **owner 不親手下指令，一切由 agent 轉錄。** 引擎相信 agent；每筆 Work Item 起始 `agent-derived`；**inbox 的意思是「agent 記了、你還沒看」**；inbox → backlog 的 review 是過目點；轉錄錯就 supersede。agent 唯一規矩：逐字不改寫，自己的觀察標 agent、owner 的話標 maintainer。
- **解釋不記作者。** 「這個檔案的不變量是 X」的權威靠追溯：碰過它的 change 帶的 `sourceRefs`、它所屬 module 的 `sources`。每個不變量都能回答「為了哪條需求」。
- Finding 必須跟著 repo：T3 §3.5a 允許 dedicated-ref，實作選了 `.git` journal。改成 ref。
- BACKLOG.md 每筆印原話、印 kind、按 lane 分組——這是過目真正發生的地方。registry plan 明文允許投影印原話。
- 流程：Finding（pending）→ convert / link / dismiss → Work Item（inbox）→ 分診 accept → backlog → active → closed。兩個決定點各答一題：「值得登記嗎」、「確定要做嗎」。
- 已裁定不做：跨 repo Finding（S12）。
- 情境細節見 `docs/research/intake-use-cases.md`（S1–S12）。

## 5c. 三種活得下來的文件

| 類 | 例 | 為什麼不腐爛 |
|---|---|---|
| 可執行 | 測試、型別、綁 test 的 scenario | 錯了會紅 |
| 生成 | BACKLOG、SPEC_MAP、COVERAGE、README 的生成段、ledger 邊 | 重印不會漂 |
| 有日期 | Source、DECISION-REGISTER、Finding | 只宣稱「某天有人這樣說」，舊不等於錯 |

唯一手寫且宣稱現在為真的是 README 的「為什麼」段；它靠 finalize 閘門（§5）逼更新。檔頭 v1 例外（§3a）。Gherkin 式 scenario 以腐爛出名，這裡的解法是綁測試，不是寫更多散文。

## 6. 交付順序

### Phase A（已部分完成）

完成：consumer 設定修正、兩個 root README、15 個檔案的檔頭（bootstrap 生成器、intake、full-gate；**不是** 13 個 module）。未完成：module 檔頭 baseline。

### Phase B：real pilot（未完成）

跑到 PlanReview 第三輪，卡在 provider 格式違規（已修）。open-task → finalize → archive 未走。**round 2 必須跑到 archive**，否則 §5 閘門沒有證據。前置：fix branch 過 full gate、rebuild tgz、re-vendor。

### Phase C（閘門優先；owner 裁定 2026-09-05）

0. **Release + pilot round 2**：fix branch full gate → tgz → vendor → 挑一個 review 一次就過的小 change 跑到 archive。
1. **原話進 ledger**：R-000..R-014 以 direct-human 捕捉；R-id 作 alias。AGENTS.md 的 R-000 段與 consumer 複本改為從 ledger 投影。同時捕捉 09-05 兩段原話：中心思想、「不希望任何開發使用者走進死胡同」。
2. **D-020**：人讀投影可引用原話。
3. **spec 搬進 module 目錄 + `sources` / `covers` / `test` + validator**（§4）；23 份 spec 對齊 13 個 module；同步補 17 份 TBD Purpose。
4. **生成器 v1**：SPEC_MAP、COVERAGE、REQUIREMENTS；BACKLOG 印原話、kind、分組；`work-history` 首次有 closed item 時生成。
5. **finalize 反向閘門 + open-task 注入**（§5）。不需要檔頭。
6. **import 邊填進 ledger 投影 + 檔頭淺抽取器**：把 `semanticDependencies: []` 換成 import 抓取；planning 時期投影接上；`Invariants:` 區塊抽取器（讀，不閘）。freshness 從此有東西可走，README 檔案表與 `covers` 有東西可查。
7. **Module README**：governance-intake 先，authority 次；2026-09-09 owner 驗收補課增加 provider-orchestration。一段手寫「為什麼」帶確認 commit，其餘四段生成（§3）；CLI usage 字串補「做什麼」欄。
8. **檔頭 baseline（縮小）**：只做 authority 與 provider-orchestration，兩段格式（§3a）；便宜 agent 寫職責句初稿，不變量由強模型或人確認。拿到真實成本再決定鋪不鋪滿。
9. **Intake 修正**：Finding → dedicated ref；更正動詞（建 supersede 鏈）；`attach` 收既有 SRC id；**之後**把 15 筆 agent Source 轉成 Finding 並刪除（#17）。（`--kind`、觀察不鑄 Source、產物排除已落地。）
10. **consumer 補課**：R-000 投影、document-policy、path-roles、schema 漂移清理。
11. **baseline reconciliation**：清 stale requirement。在第 5 步之後。
12. **可選、之後**：檔頭閘門（檔頭 digest 進 pin，finalize 要 confirm / 改 / later）；symbol 粒度；spec 搬家。

### 6b. 新 consumer：`init` / `doctor` / `upgrade`

同 v1 三層模型。實測補充：`init` 只寫一檔；沒有 `upgrade`；`doctor` 寫死 `ok:true` 只會警告不會失敗；README 說「沒有 init」是錯的。

**可攜性裁決（owner 2026-09-05）**：v1 把供應鏈驗證從「解析 pnpm-lock」抽象成 package-manager 介面，支援 npm / yarn / pnpm 的 JS 專案；非 Node 明確標不支援。**計畫記錄後續目標是真正跨語言**（check runner 抽象、非 pnpm 供應鏈、Python/Go 的 path-role 預設），排在本功能之後。

## 7. 驗收

同 v1，加：

2026-09-09 驗收方法修正：

**使用者原話（最高原則）**
> 驗收規則該改成「**可見正文**不含雜湊」，排除 HTML 註解、archive、spec。

**背景：** 原驗收把歷史證據、引擎隱藏 marker、契約及 CLI 名稱誤算為人讀正文的雜湊。
**計畫影響：** 第 2 項檢查 Markdown 呈現後的正文，只判定實際雜湊值；隱藏 HTML 註解、archive、spec 與未顯示的連結目標不計入。CLI 旗標、演算法名稱與格式佔位文字不是雜湊值。歷史證據不刪除。

**使用者原話（最高原則）**
> Q1 要盲測得換一個沒讀過 repo 的 agent。

**計畫影響：** Q1 使用沒有 repo 對話上下文的新 agent，只讀 authority README；首次讀取到形成答案須在 30 秒內，保存報告時間另計。記錄這是 agent 初讀，不能宣稱為真人盲測。Q2 由 provider-orchestration README 回答註冊方式；Q3 由 root README 說明整體流程。

**使用者原話（最高原則）**
> 在驗收 clone 裡重建 scaffold：`git update-ref refs/remotes/origin/main HEAD`，你上次已批准這個做法，驗收完就丟。

**計畫影響：** 第 3、4 項可在可丟棄的 consumer clone 建立這個本地 scaffold，使用實際 managed path 驗證；不得把 scaffold 宣稱為真實遠端發布。仍不 push，不偽造 session、Grant 或 provider 結果。

- scenario 沒有通過的測試 → `documents validate` 紅；`covers` 指向不存在的不變量 → 紅。
- 每份 README 的「為什麼」段有確認 commit，且生成器印出此後的改動檔數。
- 任何文件裡沒有手寫的依賴清單。
- BACKLOG.md 每筆底下有原話與 kind；掃一遍等於過目。
- Finding 在 fresh clone 裡看得到。
- 改 `grant-core.ts` → 依賴它的 ledger entry 變 `dependency-changed`（第 6 步之後）。
- pilot round 2 一個 change 在 consumer 上以 managed path 歸檔。

## 8. 明確不做

同 v1，加：不對檔頭設閘門（v1，只讀不閘）；檔頭不寫 `Depends on` 與 `Failure modes`；任何文件不手寫依賴；解釋不記作者；不做 symbol 粒度（v1）；不做跨 repo Finding；不把 SHALL 改寫成散文；不宣告 `owns` 除非跨目錄；不再寫任何宣稱「現在為真」而沒有閘門的手寫文件。

## 9. 決定紀錄（2026-09-05 全部裁決，無待決）

| # | 項目 | 狀態 |
|---|---|---|
| 1 | D-020 人讀投影引用原文 | **已決**：升為中心思想（§0） |
| 2 | config.yaml「grant-required paths fail closed」與 R-000 的關係 | **已決**：改 Fail-Grant，R-000 為準 |
| 3 | 檔頭 baseline 範圍 | **已決**：先兩個 module |
| 4 | symbol 粒度、spec 搬家 | **已決**：spec 搬進 module 目錄（v2.1）；symbol 粒度不做 |
| 5 | design.md 的 ledger 區塊改 prose | **已決**：做，走 MODIFIED delta |
| 6 | CLI 非 `--json` 輸出改 prose | **已決**：做，排在最後 |
| 7 | SRC/FND 的人類 alias | **併入 #1**：人讀面不出現 id，不需要 alias |
| 8 | Phase C 順序 | **已決**：閘門優先 |
| 9 | init 第 2 層不落地 | **已決**：不落地，覆蓋才生成 |
| 10 | Semantic Ledger 改為 binding + freshness index（requirement MODIFIED） | **已決**：做，併入第 6 步 |
| 11 | 正典分類 | **已決（v2.1）**：module 目錄為正典，ownership 由包含關係決定 |
| 12 | 可攜性 | **已決**：v1 JS，後續跨語言 |
| 13 | 檔頭執行力 | **已決**：v1 不閘、但要淺抽取；不變量以檔頭為主 |
| 14 | 三套分類的 Purpose TBD 何時補 | **已決**：第 3 步，與搬家一起 |
| 15 | CLI usage 字串加「做什麼」欄（供 README 生成） | **已決**：做，併入第 7 步 |
| 16 | 舊 issue 的假 timestamp 與來源 | **已決（09-08）**：不加 `legacy-unknown` 新標記（引擎不為 legacy 長胖）。`createdAt` 不能為 null（決定年份目錄），改成 migration commit 的真實時間；`interpretation.status` 改回 `agent-derived`（沒人確認過）；alias 保留 ISS-nnn |
| 17 | 15 筆 agent Source | **已決（09-08）**：每筆補建 Finding，然後刪除 Source（含 3 筆 supersede 鏈）；先移除 Work Item 的 sourceRefs 再刪物件。依賴第 9 步 Finding 進 repo，否則 Finding 只落在 `.git` |
| 18 | 人類 plan review 一頁設計 | **已決**：第 5 步之後 |
| 19 | `init` 逐步問答流程 research | **已決**：擱置 |

## 10. 執行紀錄

- **2026-09-03**：Phase A（同 v1 §10）。
- **2026-09-04**：pilot 跑到 PlanReview；11 個 finding 記進引擎 registry；fix branch `work/pilot-findings-fixes` 開始。
- **2026-09-04～05 fix branch（30 commits，摘要）**：intent 動詞拒 flag 文字；ignored 目錄記一筆；OpenSpec 從主 worktree 解析；checkpoint 錯誤說出 key、schema 附 template、manifest 去 base64；`now` 走 Fail-Grant；WHY 列以內容為身分；plan-review 欄位由引擎推導；validator 說出拒絕理由；retry 上限轉人類決策；Finding 不需 open session；產物排除出掃描；只有 origin.json 的 change 視為 reservation（finding #1）；**統一 intake：`--kind`、觀察不鑄 Source、task 內 later 轉 Finding、convert 不鑄 agent Source**（f5b1f36）。
- **2026-09-05**：intake 模型裁決（§5b）、四個決定（§9 #3/#8/#12/#13）、use case 文件 S1–S12。
- **2026-09-05 v2.1**：機械優先原則（§0.9）；spec 搬進 module 目錄、ownership 用包含關係；檔頭縮成兩段、不變量以檔頭為主、淺抽取器；README 只剩一段手寫；依賴不住任何文件。
- **2026-09-08**：另一個 session 的 09-05 計畫（§8 四項）併入 §9 #16–#19 並裁決；PLAN-projection-module-refactor 五步驗證落地（登記表六筆投影，doctor 讀 status）；PLAN-agent-guidance-projection 落地但尚未套到本 repo 的 AGENTS.md。
- **2026-09-05 晚**：§9 全部 15 項裁決完畢（owner 照 agent 建議）；中心思想升到 §0 頂端（一個權威、多處可見、只印文字）；#1/#7 併入；#2 裁定 Fail-Grant；發現 R-000 不在 ledger、DECISION-REGISTER 未引用 R-000。

## 11. 已知 drift

**舊 issue 遷移**（T3 §3.5b 要求「未知來源標 `legacy-unknown`，不補造 Source 或 timestamp」）：引擎沒有 `legacy-unknown` 標記；consumer 18 筆 legacy item 標成 `maintainer-confirmed` 但 `sourceRefs: []`；建立時間全是 `2026-08-24T00:00:00.000Z`（整點午夜，clean-slate 日）。不影響功能，但追溯時會誤以為 owner 確認過。處置見 §9 #16：真實 migration 時間 + `agent-derived`，不加新標記。列入第 10 步。

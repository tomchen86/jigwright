<!-- 使用情境探索。reference：可參考，不是 current truth。日期 2026-09-05。 -->

# 使用情境：問題與需求怎麼進系統

## 一句話

**核心需求**逐字留在 Source。**要做的事**進 Work Item，inbox 是正常入口。**Finding 是 task 中的暫存區**，之後沖進 inbox。三者互相引用，不複製文字。

## 三種記錄

| 記錄 | 是什麼 | 重量 | 誰可以寫 | 住在哪 |
|---|---|---|---|---|
| Source | 你的核心 requirement，原話逐字。不可改，只能被新的 Source 取代 | 少而重 | 你，實際上由 agent 逐字轉錄 | repo，以內容定址 |
| Finding | **task 中的暫存區。** 在 task 裡發現的觀察先放這裡，不弄髒 task 的 diff，之後沖進 inbox。有日期，算推測 | 多而輕 | agent（你在終端不需要它） | 目前在 `.git`，**應該搬進 repo** |
| Work Item | 一件要做的事。inbox → backlog → active → closed | | 兩者 | repo |

分辨的口訣：**Source 是「要照著做的話」，Finding 是「要去查的話」。**

四個原則，這次討論定下來的：

1. **「誰說的」和「是需求還是問題」是兩件事。** 作者是記錄的欄位，種類（bug / feature）是 Work Item 的 `kind`。
2. **隨口一提的 bug 不進 Source。** Source 只放你真的要的東西。Finding 自己有 `text` 欄位，`sourceRefs` 可以空，不需要先鑄 Source。
3. **inbox 是正常入口，不管有沒有進行中的 change。** Finding 只是 task 內的暫存區；它也要跟著 repo 走，不能停在 `.git`。
4. **你不親手下指令，一切由 agent 轉錄。** 引擎選擇相信 agent，但每筆 Work Item 一開始都是 `agent-derived`；**inbox 的意思就是「agent 記了，你還沒看」**。inbox → backlog 的 review 是你過目的地方，過了才變 `maintainer-confirmed`。轉錄錯了就 supersede 一筆新 Source。agent 唯一的規矩：逐字不改寫，自己的觀察標 agent、你的話標 maintainer。

Work Item 的 `kind` 有五種：`feature`、`bug`、`improvement`、`chore`、`research`。另外 `lane`（`now` / `next` / `later` / `icebox`）是多急，`stage` 是進行到哪，三個欄位互相獨立。

---

## 情境

### S1　你閒著時發現 bug

你用 app 時看到群組列表往下滑會閃白畫面。這是觀察，不是需求。

**應該**：agent 直接建一筆 inbox Work Item，`kind: bug`，不產生 Source。沒有 task 在跑，不需要 Finding 這個暫存區。

**今天：✅ 用 `work-item create --input`。** 要寫 JSON，但那是 agent 的成本，不是你的。**不要用 `later`**——它一定會鑄一筆 Source，把隨口的觀察變成永久的「最高準則」，重量不對。

---

### S2　你在 change 進行中發現一個不相干的 bug

跟 S1 一樣。agent 在主 checkout 寫 registry，不會弄髒 task 的 worktree，所以一樣直接進 inbox，不需要 Finding。

**今天：✅ 同 S1。**

---

### S3　agent 在跑 task 時發現 bug

task 中的 agent 只能改 `allowedPaths` 裡的檔案，而且觀察不該混進 task 的 diff。這就是 Finding 存在的唯一原因：一個 task 外的暫存區，事後用 convert / link / dismiss 沖進 inbox。

**今天：⚠️ 半通。** Finding 不再需要 open task session，但它存在 `.git/workflow-engine/findings`，不進 repo——clone 就消失。而且兩個 repo 到今天一筆 Finding 都沒寫過。這幾天那 12 筆 agent 觀察全部繞路寫成 Source，重量也是錯的。

**要的**：Finding 進 repo（T3 給的選項是 dedicated git ref），寫它不算違反 task 的檔案限制。

---

### S4　你想到一個新 feature

```bash
pnpm workflow later "我要在群組名稱空白時，在欄位旁邊顯示錯誤，不要跳全域 alert"
```

這是需求，進 Source 是對的。同時開一筆 Work Item 進 inbox。分診時標 `kind: feature`，寫下好處和解決什麼問題。

之後 `now <work-item-id>` 開 change，`origin.json` 引用同一筆 Source。**實作時看到的需求就是你那句話本身。**

**今天：✅ 可用。**

---

### S5　你在 change 進行中追加需求

```bash
pnpm workflow attach <work-item-id> "另外空白鍵也要算空的"
```

補充的需求，進 Source 掛到既有 Work Item。

**今天：⚠️ 半通。** `attach` 只收文字，不收已存在的 Source 編號。change 已經開了的話，要另外用 `source link-change`。

---

### S6　你跟 agent 討論，agent 幫你記

這不是例外，**這是所有 Source 進來的方式**。話是你的，作者記成 maintainer，agent 只是打字。

**今天：✅。** agent 用 `later` / `now` / `attach` 記你的原話是合法的——它們把作者寫成 maintainer，而那正是事實。引擎不檢查那句話是不是真的你說的，這是設計選擇：相信 agent，你在 review 時過目。

**規矩**：必須是你的原字，不能是改寫版。agent 自己的觀察不准走這三個動詞（那會把 agent 的話標成你的），要走 S7。

---

### S7　agent 自己的觀察

例如「這個 retry 路徑是死路」。不是你交代的。

**應該**：一筆 Finding，作者 agent。不需要 Source。

**今天：⚠️ 繞路。** 用 `source capture --input` 加 `work-item create --input`。重量錯了：agent 的推測被存成了永久原話。

---

### S8　分診：你定期清 inbox 和 pending Finding

這是前七個情境的出口。沒有這一步，記下來的東西永遠停在原地。

- `finding list` 看 pending 的 Finding，每筆三選一：`convert`（變成 Work Item）、`link`（掛到已有的 Work Item）、`dismiss`（附理由，不是問題）。
- `work-item review <id>`：accept 進 backlog，prioritize 設 lane。

**今天：✅ 指令都在，但沒人做。** 引擎 13 筆全在 inbox。finalize 之後的 nextSteps 已經會提醒「還有 N 筆 pending Finding」，只是沒人接。

順帶一提重複的問題：`later` 只對**逐字相同**的原話去重。同一件事換個說法就會建第二筆，分診時要用 `link` 合併。

---

### S9　你改主意：更正之前說過的需求

Source 不能改。更正是**新的 Source 帶 `supersedes` 指向舊的**。下游改引用新的，舊的留著當歷史。

**今天：⚠️ 機制在，入口沒有。** `now` / `later` / `attach` 四個地方全部寫死 `supersedes: null`——沒有任何一個簡短動詞會建更正鏈。要更正只能自己用 `source capture --input` 手填 `supersedes`。`attach` 是「補充」，不是「更正」。

---

### S10　緊急 bug，現在就修

```bash
pnpm workflow finding convert <finding-id> --now
```

跳過 inbox 直接開 change。D-019 說的用途是安全漏洞這類。

**今天：⚠️ 只有從 Finding 出發才行。** 沒有 Finding 時（你在討論中直接說「這個現在就修」），agent 只能 `now "..."`，那會鑄一筆 Source，和 S1 同一個重量問題。

---

### S11　你在 change 中想到一個**無關的**新需求

用 `later`，不是 `attach`。`attach` 是掛到現在這件事上；無關的事另開一筆。

**今天：✅。** 純粹是用對動詞。這條列出來是因為 S5 和它很容易搞混。

---

### S12　跨 repo 的發現　（先不管）

在 consumer 工作時發現的是**引擎**的 bug。這週實際發生了 12 次。

Finding 綁的是當下 repo 的 session 和 tree，沒有跨 repo 的機制。實際做法是切到引擎 repo 去記。

**今天：⚠️ 靠人切目錄。** 記錯 repo 的話，那筆觀察會綁到不相干的 tree 上。

**owner 裁定 2026-09-05：先不管。** 列在這裡是為了不忘記，不排進工作。

---

## 對照表

| 情境 | 該進哪 | 今天 | 卡在哪 |
|---|---|---|---|
| S1 你閒著發現 bug | inbox（不鑄 Source） | ✅ | agent 用 `work-item create`，不要用 `later` |
| S2 你在 change 中發現 bug | inbox（不鑄 Source） | ✅ | 同上 |
| S3 agent 在 task 中發現 bug | Finding | ⚠️ | Finding 不進 repo |
| S4 你想到 feature | Source | ✅ | |
| S5 你追加需求 | Source | ⚠️ | `attach` 不收既有 Source 編號 |
| S6 你跟 agent 討論，agent 記 | Source | ✅ | 這是預設路徑；規矩是逐字 |
| S7 agent 自己的觀察 | Finding | ⚠️ | 繞路，且重量錯 |
| S8 分診 | — | ✅ | 指令在，沒人做 |
| S9 更正需求 | Source（supersedes） | ⚠️ | 沒有簡短入口，四個動詞都寫死 `supersedes: null` |
| S10 緊急 bug 立刻修 | Finding → change | ⚠️ | 沒有 Finding 時只能走會鑄 Source 的 `now` |
| S11 change 中的無關新需求 | Source | ✅ | 用 `later` 不用 `attach` |
| S12 跨 repo 的發現 | Finding | ⏸ | 先不管（owner 裁定） |

---

## 缺口，按重要性

1. **Finding 不進 repo。** 存在 `.git`，clone 就沒了。至今一筆都沒寫過——這機制沒被用過。T3 的 dedicated-ref 選項就是解法。
2. **進了 inbox 就沒有下一步。** 引擎 13 筆全部停在 inbox，包括六筆已修好的；consumer 17/18 在 inbox。既然 inbox 的意思是「你還沒看」，這個數字就是待過目的量（S8）。
3. **沒有「更正」動詞。** 四個組合動詞全部寫死 `supersedes: null`，轉錄錯了或你改主意，只能手填 envelope（S9）。
4. **`attach` 不收既有 Source 編號。**
5. **沒有「不鑄 Source 直接進 inbox」的一行指令。** 只是 agent 要多寫一段 JSON，不影響你（S1）。

暫不處理：跨 repo 的發現（S12），owner 裁定先不管。

---

## 這些情境對「檔案解釋」那個功能的意思

「這個檔案的不變量是 X」——這句話的權威不靠簽名，靠追溯：

- 碰過這個檔案的 change，帶著哪些 Source
- 這個檔案所屬的 module，帶著哪些 Source

解釋本身不記作者。需要的是解釋和 Source 之間有連結。`origin.json` 已經有 `sourceRefs`，缺的是把它一路帶到解釋那一層。

而且因為 Source 現在定義成「核心需求」，這條追溯鏈的意思更清楚了：**每個不變量都能回答「這是為了滿足哪一條需求」。**

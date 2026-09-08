<!-- Dated design, reference only. This page does not authorize a transition or describe an implemented interface. -->

# 人類 PlanReview：一頁設計

日期：2026-09-08。交付範圍：[主計畫](system-description-docs-plan.md) §9 #18；第 5 步的文件處置已實作後，設計人類如何讀懂並處理同一個精確計畫。這一頁是設計產物，介面實作另行安排。

**要解決的事**：provider 不可用、重試已到上限，或使用者選擇親自過目時，人應先看到要做什麼、哪裡有問題、下一步會造成什麼結果。Source 原話、計畫、review 與 Grant 各保留原有權威；頁面只投影同一份 pinned planning snapshot。

| 頁面順序         | 顯示內容及其來源                                                                                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 這次要做什麼     | change 標題、proposal 的目的與範圍；Source ledger 原話逐字列出，保留換行。不得把 agent 摘要冒充使用者說法。                                   |
| 打算怎麼做       | design 的手寫說明、可讀 WHY 投影、tasks 與受影響 module；契約連到最近的正典 spec，顯示本次 delta。長內容可展開，不能因一頁限制截斷原話。      |
| 需要現在處理什麼 | PlanReview 的 current-change challenges，逐項顯示問題、證據位置與已記錄處置；另列 independent follow-ups，不把它們加成當次阻塞。              |
| 還有什麼不確定   | review 的 residual risk、uncertainty、實際完成或未完成的檢查。缺席或失敗的 provider review 明白寫出，不能由人按一個按鈕變成 provider 已通過。 |
| 下一步           | 使用現有流程回傳的可用動作與後果。人不必抄 ID、hash 或填技術 envelope；agent 依選擇轉成現有結構化輸入。                                       |

**一次決定的範圍**：修改計畫會產生新的 target，舊頁面與舊處置不能套到新內容。逐項處置沿用目前的 PlanReview challenge closure；需要 direct-human review 或接受具體例外時，接到既有 Central Grant 與 Human Gate，先展示精確後果，再由其授權。頁面沒有額外的批准權，也不增加第二次安全否決。選擇稍後保留現況，不宣稱計畫已獲准。

**與文件閘門的關係**：PlanReview 看計畫；finalize 的 spec／README 處置看實作後的精確候選。頁面可以顯示預計受影響的文件，不能預先替未來 diff 確認「仍成立」。Grant 跳過檢查的結果保持 `skipped-by-grant`，頁面用「已授權略過」表達。

**最小落點與驗證**：擴充現有 `propose` 的 `human-action-required` 可讀結果，沿用其 next steps、PlanReview target snapshot、finding／disposition 與 Grant request；不另建 review 資料庫。技術 ID 與完整綁定留在 `--json`。介面實作時驗證：原話逐字；同一頁只讀一個 target；內容變更使舊動作失效；required challenge 與 follow-up 分開；沒有 provider 結果時不假造通過；Grant 例外與操作失敗如實呈現。

程式依據（本次整合基準 `880e0e0`）：[propose 的輸出狀態](../../packages/workflow-engine/src/application/propose/propose-output.ts)、[PlanReview target](../../packages/workflow-engine/src/modules/assurance/plan-review-target-snapshot.ts)、[PlanReview 的逐項處置](../../packages/workflow-engine/src/modules/assurance/plan-review-disposition.ts)、[finalize 文件處置](../../packages/workflow-engine/src/application/finalize/system-document-dispositions.ts)。本交付不跑 pilot，不實作 `init` 問答，不增加檔頭閘門或 symbol 粒度。

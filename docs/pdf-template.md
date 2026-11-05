# 学内施設使用許可願 PDF

## 実装と API

- [`src/pdf.js`](../src/pdf.js) はフロントエンドから `import('./pdf.js')` で遅延読込する。`pdf-lib@1.17.1` と `@pdf-lib/fontkit@1.1.1` を使用。
- `await createApplicationPdf(data, rooms, onProgress?)` → `Uint8Array`。`onProgress(message)` は日本語の進捗文字列を受け取る。
- `await validatePdfText(data, rooms)` → `Array<{field, message}>`。初回は実際のフォントと様式を読込むため非同期。
- 溢れ・未収録文字などでは `PdfTextError` を投げる。`error.errors` は同じ形式。作成時も必ず検査するため、事前検査を省略しても黙って切り取ることはない。
- `data` は `organization, purpose, issueDate, profile:{name,studentId,phone,...}, entries:[{date,start,end,roomId,people,external,remarks}]`。`rooms` は `{id,name}` の配列。`profile.emailTo/emailCc/role` は公式用紙に対応欄がないため記入しない。
- 予約は **1〜9 件を A4 縦 1 ページ**に出力。空き行は空白。年は右上の発行日に、予約日は原紙どおり月日・曜日で記載する。日付の曜日は UTC で計算し、ブラウザのタイムゾーンに依存しない。
- 通常文字は約 9.3pt（目的 10.2pt）。必要時だけ **8pt** まで縮小。団体名・氏名・目的・場所・学外参加者・備考は書記素単位で折り返す。幅だけでなく実グリフの上下左右境界と行間を測り、罫線から 1.5pt 内側に収める。
- フォント非対応文字（絵文字等）は欄名と Unicode を示して拒否。置換・省略・クリッピングはしない。入力必須・前後関係等の業務検査は UI 側で行う。
- 同一オリジンの静的ファイルのみ `fetch`。送信、サーバー PDF 作成、ブラウザ印刷、canvas 画像化は行わない。アセットは初回のみ読込み、失敗時は再試行できる。

## 原紙・個人情報の除去

原本の「表面」シート `A1:AF54` を元にした。原本 Excel と GAS は変更しない。

[`tools/build_template.py`](../tools/build_template.py) は bundled openpyxl を使い、別ファイル [`public/templates/application.xlsx`](../public/templates/application.xlsx) を作る。

1. 「表面」以外を削除。定義名・外部リンク・画像・グラフ・コメント・ハイパーリンク・入力規則を除去。
2. 全数式を空にし、42〜50 行の動的欄と日付/時刻の空欄ヒント、旧電話番号のハイフンも消す。
3. 固定ラベル・元の結合セル・列幅・行高・**すべての罫線**を保持。保存後、再読込して元の結合・罫線と一致することを検査。
4. 印刷範囲を `A1:AF54`、A4 縦、縦横 1 ページに設定。原本の未指定/横向きの印刷設定だけを申請書用途に合わせて明示する。
5. 文書プロパティは一般名に置換。公開様式にも生成 PDF のメタデータにも元の氏名・学籍番号・電話・メールを含めない。生成 PDF 本文には利用者が入力した申請情報のみを記載する。

公式 LibreOffice Kit の `convert` で [`public/templates/application.pdf`](../public/templates/application.pdf) に変換する。罫線や固定ラベルを JS で描き直したり、画像に置き換えたりせず、既存ベクトルページへ動的文字だけを重ねる。

## 座標の根拠

[`public/templates/application.fields.json`](../public/templates/application.fields.json) が実装で読込む位置定義。PDF 左下原点・単位 pt。用紙サイズは `595.303937 × 841.889764`。LibreOffice Kit が書き出したベクトル罫線から測定した値であり、スクリーン画像からの目測ではない。

| 動的項目 | 原紙セル | PDF の主な境界 |
|---|---|---|
| 発行年/月/日 | `Y1:Z1` / `AB1` / `AD1` | x=410.064 / 450.793 / 478.527 |
| 団体名 | `V14:AF15` | x=369.335〜520.996、下辺 y=596.325 |
| 学籍番号 | `X17:AF18` | x=396.488〜520.996、下辺 y=564.295 |
| 氏名 | `X20:AF21` | x=396.488〜520.996、下辺 y=532.265 |
| 携帯番号 | `X22:AF22`（元は番号を分割） | x=396.488〜520.996、y=518.319〜532.265 |
| 使用目的 | `H34:AF35` | x=168.929〜520.996、y=372.747〜393.665 |
| 予約 1〜9 行 | 42〜50 行 | 上辺 y=307.290、最終下辺 y=56.269 |
| 月日・時間・場所・人員・学外・備考 | `A:G` / `H:O` / `P:T` / `U:W` / `X:AB` / `AC:AF` | x 境界=73.893,168.929,287.875,355.758,396.488,464.370,520.996 |

目的欄は原紙で約 21pt の高さしかない。通常の目的文は収まるが、長文すべてを記入できるわけではない。限界超過時は短縮を依頼する。様式を再出力する際は、LibreOffice の版・印刷倍率で座標が変わり得るため、ベクトル座標と全欄の出力を再検証すること。

## 日本語フォントと再取得

[`public/fonts/NotoSansJP-Regular.ttf`](../public/fonts/NotoSansJP-Regular.ttf) は Noto Sans JP Regular。約 5.74MB・17,808 グリフ。Windows のフォントファイルを公開していない。フォントは SIL OFL 1.1（[`OFL.txt`](../public/fonts/OFL.txt)）で再配布・PDF 埋込可能。

配布元は npm の [`@expo-google-fonts/noto-sans-jp@0.4.4`](https://registry.npmjs.org/@expo-google-fonts/noto-sans-jp/0.4.4)。その `400Regular/NotoSansJP_400Regular.ttf` と `LICENSE_FONT` を使用。パッケージをアプリ依存へ追加する必要はない。

```powershell
& $node tools/fetch_pdf_font.mjs
& $python tools/prepare_pdf_font.py
```

[`fetch_pdf_font.mjs`](../tools/fetch_pdf_font.mjs) は pinned tarball を SHA-512 検証して保存。[`prepare_pdf_font.py`](../tools/prepare_pdf_font.py) は glyph レコードを 2 バイト境界へパディングし、`loca` と SFNT チェックサムを更新する。**全グリフのアウトライン・命令・メトリクスは不変**。元 TTF の長形式 `loca` には奇数オフセットがあり、fontkit 1.1.1 が小さな subset を短形式に変換すると切捨てで文字欠落を起こすため、この正規化が必要。無加工 TTF への置換は不可。

ブラウザでは `subset:true` で使用したグリフのみ PDF に埋込む。通常の完成 PDF は約 **45〜47KB**（テスト時）。5.74MB 全体を PDF に埋め込まない。

## 再構築・検査

`$python` と `$node` は `load_workspace_dependencies` の bundled 実行ファイル。Office 操作には `office-export-pdf` / `office-render` skill が指定する**絶対 CLI パス**を使用する。

```powershell
& $python tools/build_template.py
& $officeNode $officeCli convert --input 'public/templates/application.xlsx' --output 'public/templates/application.pdf'
& $node tools/inspect_template.mjs
& $node tools/test_pdf.mjs
# inspection-only: workspace 内の一意な一時親を作成し、未作成の子へ出力
& $officeNode $officeCli render --input 'tools/pdf-test-output/application-9.pdf' --output-dir "$uniquePreviewParent/render" --pages '1'
```

[`inspect_template.mjs`](../tools/inspect_template.mjs) は `%PDF-`、ページ数、用紙サイズ、メタデータを確認し、ベクトル内容を診断用に抽出する。[`test_pdf.mjs`](../tools/test_pdf.mjs) はダミーデータで 1 行・9 行・長文折返し・溢れ・未収録文字・10 行拒否を検査する。元データの個人情報をテストに流用しない。

実施した確認: テンプレートと 1 行・9 行・長文折返しの各 PDF を指定の `office-render`（LibreOffice Kit/pdfium）で描画し、すべて 1 ページ、欠落文字・罫線との重なり・領域外への溢れがないことを画像で確認。テンプレートのフォント不足診断は空。検査用プレビュー画像は公開アセットではない。

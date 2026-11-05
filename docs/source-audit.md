# 教室・全写真の出典整理

## 概要

- 原資料：[教室データベース](<../【YC】学内施設使用許可願生成マシーン (2).xlsx>) と [ROOMLIST](<../roomlist.pdf>)（40物理ページ）。
- 元ブック37室を保持し、PDF掲載の **33J・21A・22H** とユーザー指定の **72A・72BC** を追加。アプリ登録は **42室**。空白のxlsx38行目から架空教室を作成していない。
- **72A・72BCはユーザー提供情報**（7号館2階）。ROOMLISTには7号館の掲載がなく、PDF・XLSX由来と表記しない。追加指定時点の定員・設備・写真は未提供。管理者が後日追加した写真は別出典として記録。
- XLSX既存写真 **16点すべて保持**（室内3・外観13）。元画像はブックZIP内メディアとバイト単位で同一。
- PDF全37教室ページに掲載された写真 **148点すべて** を収録。室内全景・机・AV機器ラック等の写真を含む。上段1枚だけの抽出ではない。
- 合計 **164 WebP**（既存16 + PDF148 + 管理者追加0）、3,062,386 bytes（約2.92 MiB）。
- 室内写真あり37／42室。**22A・22F・72D・72A・72BCは写真なし**。他室の写真で代用しない。
- PDF埋込画像154出現を全分類し、写真148・記号6と照合。フロア図・配線図・トイレ等の記号をgalleryへ混入させていない。フロア図の大半はベクトルであり写真抽出の対象外。
- 学生ホールp34は図の左下にも写真があるため、右側だけを選ぶ位置閾値で除外しない。
- 原H列コメントは37室すべて原文維持。PDF新規3室に推測コメント・設備を追加しない。

## 後方互換スキーマ

- [教室JSON](<../public/data/rooms.json>) は42件の配列。従来の `images.interior/exterior`・`photoStatus`・既存47代表画像のパス/IDを維持。
- [ユーザー追加マニフェスト](<../public/data/custom-rooms.json>) は `schemaVersion:1, rooms:[room]`。72A・72BCを永続保存し、全体生成・gallery再生成のどちらでも最終段でマージする。
- ユーザー追加室は `source.type:user-provided`・`addedFromUser:true`・`xlsx:null`・`pdfPages:[]`・`pdfLabel:null`。所在地根拠も `user-provided`。マニフェストの初期状態は `capacity/equipment` と両代表写真がnull、`gallery:[]`、両 `photoStatus` がmissing。
- [管理者写真マニフェスト](<../public/data/admin-photos.json>) は `schemaVersion:1, photos:[{id,roomId,src,kind,source,width,height,sha256,bytes,addedAt}]`。IDは `admin-UUID`、保存先は `images/rooms/admin-UUID.webp`、出典は `管理者追加`。再生成時にファイルのSHA-256・寸法を検証してマージし、元資料の写真と区別。写真がない代表枠のみ最初の追加写真で補い、既存代表写真は差し替えない。
- 各roomへ `gallery:[{src,kind,source,page,sourceId,width,height}]` を追加。kindはinterior/exterior。写真なしの教室は空配列。
- galleryは従来の代表写真を先に、その後PDFの残り写真をページの上から左→右順に追加。同じPDF画像を代表とgalleryで二重登録しない。
- [出典台帳](<../public/data/photo-sources.json>) schemaVersion2。各写真に原画像SHA-256、xref、物理ページ、配置座標/変換行列、WebPのSHA-256・寸法を記録。
- 歴史的な `pdfOnlyRooms` 配列は削除せず、3室すべて `status:included` に更新。
- 台帳は42室×室内/外観の84原資料代表写真枠を記録（ユーザー追加室の未提供4枠もmissing）。gallery追加114記録と管理者追加0記録を合わせ198写真記録、うち利用可能164点。`roomCount:42`・`primaryPhotoSlots:84`・`addedUserRooms:[72A,72BC]`。元ブックは37室・38行枠・空白38行目のまま。
- 管理者写真の台帳は `sourceType:admin`・`source:管理者追加`・`id:admin-UUID`。代表採用時も原資料のmissing記録をavailable複製せず、`images.kind.sourceId` を管理者写真IDへ向ける。集計の `adminPhotographs`・`galleryPhotoCount`・`webpCount` はマニフェスト件数を加算。

## 原本・向き・軽量化

- [既存抽出原本](<../assets/source-photos/xlsx/>)（16点）と [PDF原画像](<../assets/source-photos/pdf/>)（154出現）を無加工のまま保管。元画像を削除・差替えしない。
- [配布WebP](<../public/images/rooms/>) はPillowで品質80、最大1440×1080、拡大なし。PDF内の小さい写真はその解像度を維持。
- PDFで90度回転配置されていた機器写真32点は、配布用WebPのみPDF変換行列に従って向きを補正。元のJPEG 2000/PNG等のバイトは不変。

## 新規教室と定員

| 教室 | 写真ページ | 所在地の根拠 | 定員 |
|---|---:|---|---:|
| 33J教室 | p31 | p3「3号館3階」のフロア図 | 12（p31個別表） |
| 21A教室 | p35 | p2「2号館1階」のフロア図 | 100（p1一覧・p35） |
| 22H教室 | p39 | p2「2号館2階」のフロア図 | 100（p1一覧・p39） |
| 72A教室 | — | ユーザー提供：7号館2階 | null（未提供） |
| 72BC教室 | — | ユーザー提供：7号館2階 | null（未提供） |

- 定員は日付付きp1「2025年9月現在」一覧を優先。33Jはp1にないためp31個別表の12を採用し、日付は不明としてnull。
- YCホール・学生ホールの定員欄「-」、22A・22F・72Dの該当記述なし、ユーザー追加72A・72BCの未提供定員はnull。設備は全件nullのまま。
- 一覧と個別ページの定員差異5件は両値を保存し、勝手に訂正しない。

| 教室 | p1一覧（採用） | 個別ページ |
|---|---:|---|
| 32I | 58 | 60（p19） |
| 32J | 53 | 51（p20） |
| 33A | 40 | 42（p22） |
| 33B | 40 | 41（p23） |
| 33G | 20 | 40（p28） |

## 全教室・写真数

| 教室 | XLSX行 | PDF写真ページ | PDF全写真 | gallery計 |
|---|---:|---:|---:|---:|
| 31A教室 | 2 | 5 | 6 | 6 |
| 31B教室 | 3 | 6 | 5 | 5 |
| 31C教室 | 4 | 7 | 4 | 4 |
| 31D教室 | 5 | 8 | 4 | 4 |
| 31E教室 | 6 | 9 | 5 | 5 |
| 31F教室 | 7 | 10 | 4 | 4 |
| 32A教室 | 8 | 11 | 6 | 6 |
| 32B教室 | 9 | 12 | 5 | 7 |
| 32C教室 | 10 | 13 | 2 | 3 |
| 32D教室 | 11 | 14 | 5 | 6 |
| 32E教室 | 12 | 15 | 2 | 2 |
| 32F教室 | 13 | 16 | 4 | 5 |
| 32G教室 | 14 | 17 | 4 | 5 |
| 32H教室 | 15 | 18 | 4 | 4 |
| 32I教室 | 16 | 19 | 4 | 4 |
| 32J教室 | 17 | 20 | 4 | 5 |
| 32K教室 | 18 | 21 | 4 | 5 |
| 33A教室 | 19 | 22 | 4 | 4 |
| 33B教室 | 20 | 23 | 4 | 4 |
| 33C教室 | 21 | 24 | 2 | 3 |
| 33D教室 | 22 | 25 | 2 | 3 |
| 33E教室 | 23 | 26 | 2 | 3 |
| 33F教室 | 24 | 27 | 2 | 3 |
| 33G教室 | 25 | 28 | 4 | 5 |
| 33H教室 | 26 | 29 | 4 | 6 |
| 33I教室 | 27 | 30 | 4 | 4 |
| 33K教室 | 28 | 32 | 4 | 4 |
| 22A教室 | 29 | — | 0 | 0 |
| 22B教室 | 30 | 36 | 4 | 4 |
| 22D教室 | 31 | 37 | 4 | 4 |
| 22E教室 | 32 | 38 | 4 | 4 |
| 22F教室 | 33 | — | 0 | 0 |
| 22G教室 | 34 | 40 | 5 | 5 |
| 学生ホール | 35 | 34 | 4 | 5 |
| FEISホール | 36 | 4 | 7 | 7 |
| YCホール | 37 | 33 | 4 | 4 |
| 72D教室 | 39 | — | 0 | 0 |
| 33J教室 | — | 31 | 4 | 4 |
| 21A教室 | — | 35 | 4 | 4 |
| 22H教室 | — | 39 | 4 | 4 |
| 72A教室 | — | — | 0 | 0 |
| 72BC教室 | — | — | 0 | 0 |

## 再現・検証

Pythonはbundled Pythonとopenpyxl/Pillow、抽出専用のPyMuPDFを使用。既存の原資料監査ではoffice-renderスキル指定LibreOffice Kit CLI（native/pdfium、144dpi）で描画した37教室ページ全点を目視照合済み。今回のユーザー指定2室にPDFページ根拠を追加していない。PyMuPDFをページレンダリングには使わない。

```text
python tools/extract_room_sources.py
python tools/map_room_pdf.py
python tools/enrich_room_metadata.py
python tools/build_rooms_data.py  # 最終段でbuild_room_galleries.pyも実行
python tools/validate_room_sources.py
```

galleryだけ再生成する場合：`python tools/build_room_galleries.py`（冪等）。
- 164 WebPのデコード・寸法・参照・SHA-256一致。原画像148写真すべてのhashとPDF埋込画像を照合。管理者追加0点も独立マニフェストと照合。
- 16既存原本がxlsx ZIPメディアと完全一致し、従来47代表写真の参照を維持。
- 42ID一意、37元H列原文一致、ユーザー追加2室の出典・定員未提供を照合。全148PDF写真が一意にgalleryへ対応、6記号と全154埋込出現の分類漏れなし。
- 原資料・写真の権利は原権利者に帰属。学外公開・再配布の許諾はこの作業で取得していない。写真には人物が写るものがあり、公開範囲は管理者が確認すること。

## 原資料のSHA-256

- [【YC】学内施設使用許可願生成マシーン (2).xlsx](<../【YC】学内施設使用許可願生成マシーン (2).xlsx>)：`887cf5cf8f14e73dda43dc0a929dd639aaa2da93c7809888cd7b910bcb68b8ad`
- [roomlist.pdf](<../roomlist.pdf>)：`ab1fafc2e5e581c9a5daa1add1380d34d7bcee909508bb614500328a7751c728`

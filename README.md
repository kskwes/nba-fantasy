# NBA Fantasy

自分専用のシンプルなNBAファンタジー。サーバー不要の静的サイトで、GitHub Pages でそのまま動きます。
https://kskwes.github.io/nba-fantasy/

## ルール

| 項目 | 内容 |
|---|---|
| 形式 | シーズン型（週単位で集計） |
| チーム | 8人・予算 $200。全員の得点を合計（ポジション枠・ベンチなし） |
| 値段 | 前シーズンの1試合平均FPTS（最低 $5、前季データなしは $10）。シーズン中は固定 |
| 得点 | Yahoo標準：PTS ×1 / REB ×1.2 / AST ×1.5 / STL ×3 / BLK ×3 / TO ×−1 |
| 週 | 月〜日（米国東部時間）。その週の最初の試合開始でロスター確定 |
| 入れ替え | 前週のロスターから週2人まで（最初の編成は自由）。確定後の変更は翌週分 |
| 目標スコア | 8人 × その週の1チーム平均試合数 × 基準値（Bronze 22 / Silver 27 / Gold 32） |
| CPU | 毎週、同じ予算内でランダム編成（$10以上・前季40試合以上・欠場中を除く） |

ルールの数値は `app.js` 冒頭の `CONFIG` で変更できます。

## ファイル構成

```
index.html             画面の骨組み
app.js                 ロジック（データ取得・集計・描画）
style.css              スタイル
manifest.webmanifest   ホーム画面追加用
icon.svg / icon-*.png  アイコン
```

## データ

ESPN の公開APIをブラウザから直接取得しています（`nba/` 配下の既存ページと同じ方式）。

- 選手一覧：`teams/{id}/roster`（30チーム分）
- 値段：`statistics/byathlete`（前シーズンの平均成績）
- 日程：`scoreboard?dates=YYYYMMDD`（日別）
- 試合ごとのスタッツ：`summary?event={id}`（ボックススコア）

ロスター・履歴はブラウザの localStorage に保存されます（端末間の同期はありません）。

## 公開手順（GitHub Pages）

1. GitHub で `nba-fantasy` リポジトリを作成
2. このフォルダの中身をリポジトリ直下にアップロード
3. Settings → Pages → Source を「Deploy from a branch」、Branch を `main` / `(root)` にして保存
4. 数分後に `https://<ユーザー名>.github.io/nba-fantasy/` で公開される

## iPhone での使い方

1. Safari で上のURLを開く
2. 共有ボタン →「ホーム画面に追加」
3. 以後はホーム画面のアイコンから起動する

Safari は7日間アクセスのないサイトのデータを消すことがありますが、ホーム画面から起動するアプリはその対象外です。
念のため「設定」タブから定期的にバックアップ（JSON書き出し）をしてください。

## 修正をアップするとき（バージョンの上げ方）

`index.html` の次の3か所を、同じ新しい番号に書き換えてからアップロードする。

```html
<meta name="app-version" content="1.1">
<link rel="stylesheet" href="style.css?v=1.1">
<script src="app.js?v=1.1"></script>
```

アプリは起動時とアプリに戻ってきたときに、サーバー上のバージョンを確認する。新しい版があれば「新しいバージョンがあります」と表示されるので、「更新」を押すと最新版が読み込まれる（保存データは消えない）。
「設定」タブの「アプリを更新」でも、手動で同じ操作ができる。

## ローカルでの開発

```sh
cd nba/nba-fantasy
python3 -m http.server 8000
# → http://localhost:8000
```

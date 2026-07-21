# STARFALL MAGIC ACADEMY ユーザー向け README

この文書は、GitHub Releases で配布されている macOS 版 / Windows 版のゲームを遊ぶ人向けの説明です。
開発者向けの説明は `README.md` を参照してください。

## 重要: このゲームは日本語専用です

本作は、**日本語で遊ぶことを前提にした開発プレビュー版**です。
ゲーム内テキスト、キャラクター会話、設定説明は日本語向けです。

英語など他言語でのプレイは、現時点では対応していません。

## 重要: LM Studio が必要です

本作は、ローカル LLM を使ったキャラクター会話を中核にしています。
通常のゲームプレイには、LM Studio が起動しており、ローカル API が利用できる状態であることが必要です。
LM Studio への接続は、同じ PC / Mac の localhost、または同じローカルネットワーク上の別マシンを想定しています。

LM Studio がない、モデルが違う、または設定が不足している場合、ゲームは正常に進行しません。

## 推奨プレイ環境

推奨プレイ環境は、**macOS 版のゲームを Mac で起動し、同じローカルネットワーク上で動作する LM Studio の OpenAI-compatible API に接続する構成**です。

Windows 版でプレイし、LM Studio を同じ PC の localhost として動かす構成でも動作します。
ただし、相対的にテストは不十分であり、ゲーム体験は若干劣ります。

## ダウンロードと起動

GitHub Releases の Assets から、使用する OS に合った配布ファイルをダウンロードしてください。

### macOS 版

macOS 版は `.dmg` として配布されています。
現在の macOS 版は **Apple Silicon Mac 向け**です。

1. `.dmg` をダウンロードして開く
2. 中の `.app` を `Applications` フォルダにドラッグする
3. `Applications` フォルダからアプリを起動する

`.dmg` を開いただけでは、アプリは `Applications` フォルダに登録されません。

### Windows 版

Windows 版は `.exe` インストーラーとして配布されています。
Assets から Windows 用インストーラーをダウンロードして実行してください。

Windows SmartScreen やブラウザが警告を表示することがあります。
警告が出る場合は、配布元、ファイル名、チェックサム、リリースノートを確認してから実行してください。

## 初回起動後の LM Studio 接続設定

ゲーム起動後、まず最初に設定ボタンから LM Studio への接続設定を完了させてください。

接続先ホストを正しく設定し、「モデル一覧を取得」ボタンからモデル名が取得できれば接続は確立されています。
適切なモデルを選択し、保存ボタンを押してください。

保存ボタンが枠外にあるなど、レイアウト崩れが生じている場合は、この画面で適切な位置に収まるよう、ツールバーから Zoom in もしくは Zoom out を行うことを推奨します。

### 接続先 URL について

LM Studio をゲームと同じ PC / Mac で動かす場合は、通常は次の URL を使います。

```text
http://127.0.0.1:1234/v1
```

推奨構成のように、ゲームを Mac で起動し、LM Studio を同じローカルネットワーク上の別マシンで動かす場合は、`127.0.0.1` ではなく LM Studio が動いているマシンの LAN 内 IP アドレスを使います。

例:

```text
http://192.168.x.x:1234/v1
```

LM Studio 側では Local Server / OpenAI-compatible API を有効にしてください。
ファイアウォールやセキュリティソフトが LAN 内通信を妨げている場合、ゲーム側から接続できません。

## LLM と VRAM について

本作は、**Gemma 4 31B 系モデル**を前提にしたゲームです。

Gemma 4 31B 系モデルを長いコンテキストで動かすため、4bit 水準での量子化なしでは動作は厳しいです。
作者の手元では VRAM 24GB の GPU を使用しているため、24GB 環境で動かすための設定として、次の LM Studio 設定を想定しています。

| 項目 | VRAM 24GB 環境での想定設定 |
|---|---|
| モデル | `lmstudio-community` の Gemma 4 31B `q4_k_m` |
| ゲーム側モデル名 | 例: `lmstudio-community/gemma-4-31b-it` |
| コンテキストサイズ | `64000` |
| 評価バッチサイズ | `2048` |
| KV Cache Quantization | 4bit 量子化が必要 |
| Max Concurrent Predictions | `1` |
| Unified KV Cache | 無効 |
| API 形式 | OpenAI-compatible API |
| API URL | `http://127.0.0.1:1234/v1` または LAN 内の LM Studio API URL |

この設定は、VRAM 24GB 環境で動かすための設定です。
より大容量の VRAM がある GPU では、24GB 向けの制約をそのまま使う必要はないはずです。

特に、KV キャッシュ量子化は使わないほうが性能面で有利になるとされています。
VRAM に余裕がある場合は、Max Concurrent Predictions や Unified KV Cache についても、より緩い設定にできるかもしれません。

ただし、作者は現時点で VRAM 24GB 環境のみを使用しているため、より大容量の VRAM 環境での最適設定は未検証です。

## 開発 repo から実行する場合の設定ファイル

開発 repo から実行する場合、設定例は次のファイルにあります。

```text
app/config/lmstudio.example.json
```

実際に使う設定ファイルは次のパスです。

```text
app/config/lmstudio.json
```

例:

```json
{
  "provider": "lmstudio",
  "base_url": "http://127.0.0.1:1234/v1",
  "chat_model": "lmstudio-community/gemma-4-31b-it",
  "reflection_model": "lmstudio-community/gemma-4-31b-it",
  "timeout_ms": 120000,
  "stream": true,
  "mock_provider_enabled": true
}
```

`base_url` は、LM Studio を同じ PC / Mac で動かす場合の例です。
ローカルネットワーク上の別マシンで LM Studio を動かす場合は、そのマシンの LAN 内 IP アドレスに変更してください。

配布版では、ゲーム内の設定画面から LM Studio 接続設定を保存できます。
ただし、LM Studio 側のモデルロード、コンテキストサイズ、KV キャッシュ設定は LM Studio 側で行う必要があります。

## トラブルシューティング

### ゲームが会話で止まる / 進まない

LM Studio が正しく起動していない可能性があります。

確認してください。

- LM Studio の Local Server / OpenAI-compatible API が起動しているか
- ゲーム側の接続先 URL が正しいか
- 別マシンの LM Studio に接続する場合、LAN 内 IP アドレスを使っているか
- ゲーム側の `chat_model` / `reflection_model` が LM Studio 側のモデル名と一致しているか
- モデル一覧を取得できるか
- モデルがロード完了しているか
- VRAM が不足していないか

### モデルロードに失敗する / 生成が極端に遅い

VRAM または LM Studio 側の量子化・コンテキスト設定が原因の可能性があります。

VRAM 24GB 環境では、次を確認してください。

- `lmstudio-community` の Gemma 4 31B `q4_k_m` を使っているか
- Context Size が `64000` か
- Evaluation Batch Size / 評価バッチサイズが `2048` か
- KV Cache Quantization が 4bit か
- Max Concurrent Predictions が `1` か
- Unified KV Cache が無効か

より大容量の VRAM がある環境では、24GB 向けの制約をそのまま使わないほうがよい場合があります。
ただし、このリリースでは作者の手元で未検証です。

### API 接続エラーが出る

LM Studio の Local Server 設定とネットワーク設定を確認してください。

- OpenAI-compatible API が有効か
- ポートが `1234` か
- 同じ PC / Mac で動かす場合、`http://127.0.0.1:1234/v1` にアクセスできるか
- 別マシンで動かす場合、`http://<LAN内IP>:1234/v1` にアクセスできるか
- セキュリティソフトやファイアウォールが localhost / LAN 内通信を妨げていないか

## 生成AI素材について

本作には、生成AIを用いて制作した画像素材が含まれます。

リポジトリや配布物が公開されていても、ゲーム内の画像・素材・キャラクター素材の再利用を許可するものではありません。
素材の扱いについては `assets/README.md` も参照してください。

## ライセンスと再利用

このプロジェクトは、現時点では **All Rights Reserved** の方針です。

- コードのライセンス: `LICENSE` を参照
- アセットの扱い: `assets/README.md` を参照
- リポジトリの閲覧可能性は、コードや素材の再利用許可を意味しません

## 現在の位置づけ

このゲームは、完成品リリースではなく、**開発プレビュー版**です。

特に次の点に注意してください。

- 日本語専用です
- LM Studio と高性能 GPU が必要です
- ローカル LLM の設定に強く依存します
- 会話生成、進行、セーブデータ、表示まわりに不安定な部分が残っている可能性があります
- 仕様やセーブデータ形式は今後変わる可能性があります

# 素材について

このディレクトリには、ゲームが使う絵と音と、それらの出所と扱いの説明があります。

## 置き場所

- `canonical/` — ゲームが実際に使う素材です。タイトル・ロード・各場面の背景、生徒たちの絵、画面の部品、BGM、奏楽堂の楽器の音源などが、場面ごとのディレクトリに分かれています。ゲームのサーバーはここを `/canonical/` の下で配ります。
- `app-icons/` — デスクトップ版のアプリのアイコンです。
- `mapping/` — 素材の制作のときの置き場所と、いまの置き場所との対応表です。

## 出所

絵は、Codex を通して OpenAI の画像生成で作り、このゲームのために選んで整えたものです。BGM は `stabilityai/stable-audio-3-small-music` で生成しています。

奏楽堂の演奏に使う音源（FluidR3Mono SoundFont）だけは、このプロジェクトが作ったものではなく、MIT ライセンスで公開されている第三者の音源です。この音源の扱いは、同じ場所にある `canonical/concert_hall/LICENSE.txt` に従います。

制作を続けるために、リポには素材の元の置き場所の記録や対応表、ハッシュなどを残しています。これらは素材の再利用を認めるものではなく、生成の経緯やプロンプトをすべて公開するという約束でもありません。

素材の扱いを定めた次の節は、権利にかかわる文言なので、英語の原文のまま置いています。

## Reuse boundary

Unless a separate written permission says otherwise, project assets in this repository are not granted for third-party reuse just because the repository is visible.

That includes, at minimum:

- character art
- UI art
- background art
- title/load imagery
- generated/derived shipping assets produced through the project's Codex/OpenAI image-generation workflows

If a future release needs a broader reuse grant, document it explicitly. Until then, treat the asset surface as project-owned and all-rights-reserved.

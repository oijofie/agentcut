## agentcut
自然言語で操作できるブラウザベースの動画編集エディタ。動画内容の分析、文字起こし、シーン検出、切り抜き生成などができる。

## Setup

### Prerequisites

- [Bun](https://bun.sh/docs/installation) (v1.2.18+)

### 1. Install & Environment

```bash
bun install
cp packages/mcp-server/.env.example packages/mcp-server/.env
```

`packages/mcp-server/.env` を開いて、APIキーを設定してください:

```
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
```

Claude Code で MCP サーバーを使う場合は、プロジェクトルートに `.mcp.json` を作成してください:

```json
{
  "mcpServers": {
    "opencut": {
      "command": "bun",
      "args": ["run", "packages/mcp-server/src/index.ts"]
    }
  }
}
```

### 2. Start Dev Server

3つのプロセスをそれぞれ別ターミナルで起動します:

```bash
bun dev:web          # Web app (port 3000)
bun dev:ws-bridge    # WebSocket bridge (port 3001)
bun dev:mcp          # MCP server
```

http://localhost:3000 でエディタが開きます。

> Note: `ws-bridge` と `mcp` は AI エージェント連携に必要です。エディタ単体で使う場合は `bun dev:web` だけで OK。


## How to Use

### 1. 動画内容の分析
`/analyze` コマンドで動画のシーン分析・文字起こし・Markdown出力を一括実行する。

### 2. 切り抜き箇所の特定
分析結果から切り抜き候補を推薦する。

### 3. 切り抜きの実施
切り抜き動画用に、縦型変換、テロップ・画像付与などを自然言語で指示する。

## MCP Tools

| Tool | Description |
|------|-------------|
| `get_timeline` | タイムラインの状態を取得 |
| `split` | 指定時間でクリップを分割 |
| `remove_range` | 指定範囲のコンテンツを削除 |
| `trim` | イン/アウト点を調整 |
| `undo` / `redo` | 取り消し/やり直し |
| `seek` | 再生位置を移動 |
| `play` / `pause` | 再生/一時停止 |
| `add_text` | テロップを追加 |
| `add_image` | 画像オーバーレイを追加 |
| `add_effect` | エフェクトを追加 |
| `set_canvas_size` | キャンバスサイズを変更 |
| `list_media` | メディア一覧を取得 |
| `transcribe_api` | OpenAI Whisperで文字起こし |
| `transcribe_local` | ローカルWhisperで文字起こし |
| `detect_scenes` | シーン変化を検出 |
| `create_video_labels` | Geminiで動画を分析・ラベリング |
| `get_video_labels` | 保存済みラベルを取得 |
| `clip_recommendation` | 切り抜き候補を推薦 |
| `clip_create` | 指定範囲でクリップを作成 |
| `generate_scene_md` | シーン分析をMarkdown出力 |


## Acknowledgement
Built on [OpenCut](https://github.com/OpenCut/opencut)(MIT Licence).

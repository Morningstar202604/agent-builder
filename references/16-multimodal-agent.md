# 16 — 多模态 Agent · 图片/语音/屏幕

> 目标：在 01 的文本 Agent 之上叠加多模态能力——图片理解、TTS 语音输出、STT 语音输入、屏幕录制观测、图片生成。读完本文件可独立落地 Modality Router 与 Media Chat 的全部业务代码。

> **⚠️ 本层铁律：不自研，直接接成熟方案。**
> - 图片理解 / TTS / STT / 图片生成 → **官方 SDK**（OpenAI / Anthropic / Replicate），不要手写 HTTP 客户端
> - 图片压缩与转码 → **ffmpeg**（胶水层调用系统命令）
> - 屏幕录制 → **浏览器 `getDisplayMedia` + `MediaRecorder` / Electron `desktopCapturer`**（平台 API，不是轮子）
> - 语音实时识别 → 浏览器 **Web Speech API**（平台能力）
> - 多模态消息 → Vercel AI SDK 的 `content` parts 原生支持图片，不要手写 `image_url` 拼装
>
> 本层唯一允许手写的 `[CUSTOM]` 是 **Modality Router 的选型决策**——它只做"哪个模态走哪个模型"的业务判断，不实现任何协议或 Provider。

---

## 目录

- [工程逻辑：多模态 Agent 架构](#工程逻辑多模态-agent-架构)
- [0. 多模态 Provider 现状（2026）](#0-多模态-provider-现状2026)
- [1. Modality Router [CUSTOM]](#1-modality-router-custom)
- [2. 图片理解管线](#2-图片理解管线)
- [3. TTS 语音输出](#3-tts-语音输出)
- [4. STT 语音输入](#4-stt-语音输入)
- [5. 屏幕录制 Agent](#5-屏幕录制-agent)
- [6. 图片生成](#6-图片生成)
- [7. 前端：Media Chat](#7-前端media-chat)
- [8. AI 避坑](#8-ai-避坑)
- [9. 本层验收清单](#9-本层验收清单)

---

## 工程逻辑：多模态 Agent 架构

现代 Agent 不只是"文字输入 → 文字输出"。用户拍一张图问"这是什么？"、用语音输入、要求 Agent 朗读回答、甚至让 Agent 观测屏幕变化——这些是多模态 Agent 的必备能力。

核心设计挑战：**不是所有模型都支持所有模态**。Claude 可以看图但不能生图，DALL-E 能生图但不能看屏幕截图。需要一个 Modality Router 把不同模态的请求分发到正确的服务。

```
┌─────────────────────────────────────────────────────────────────┐
│                  多模态 Agent 架构                                 │
│                                                                   │
│  ┌────────────┐     ┌────────────┐     ┌────────────┐          │
│  │  语音输入   │     │  文字输入   │     │  图片输入   │          │
│  │ (STT/Web   │     │  (Text)    │     │  (Vision)  │          │
│  │  Speech)   │     │            │     │            │          │
│  └─────┬──────┘     └─────┬──────┘     └─────┬──────┘          │
│        │                  │                  │                    │
│        ▼                  ▼                  ▼                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Modality Router [CUSTOM]                        │  │
│  │  只做选型决策：哪个模态走哪个模型/SDK                         │  │
│  │  - 图片+文字 → gpt-4o（AI SDK 多模态消息）                    │  │
│  │  - 纯文字 → 默认文本模型                                      │  │
│  │  - 语音输入 → whisper-1（OpenAI SDK）                         │  │
│  │  - 语音输出 → tts-1（OpenAI SDK）                             │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                       │
│                           ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Agent Core Loop                                 │  │
│  │  (来自 01-foundation.md 的 streamText + tools)               │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                       │
│              ┌────────────┼────────────┐                         │
│              ▼            ▼            ▼                         │
│       ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│       │  TTS     │ │  图片生成 │ │  纯文字   │                   │
│       │ (tts-1)  │ │ (dall-e) │ │  (Text)  │                   │
│       └──────────┘ └──────────┘ └──────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

**关键设计原则**：
1. **模态透明**：Agent Core 不关心输入是文字还是图片，只需在消息中标记模态类型。Modality Router 负责选模型。
2. **渐进增强**：去掉多模态能力，Agent 仍然正常工作（退化为纯文本 Agent）。
3. **资源可控**：多模态 token 消耗暴增。图片压缩、流式播放、限流都是必要的。

---

## 0. 多模态 Provider 现状（2026）

多模态能力已经收敛为“旗舰模型原生支持”：OpenAI / Anthropic / Google 的旗舰模型都把图片、音频、视频输入作为默认能力，而 TTS / STT / 图片生成仍然是**独立的官方 API**。本层所有 Provider 交互都走官方 SDK，不手写 HTTP。

### Provider 能力对比

| Provider | 多模态输入 | TTS | STT | 图片生成 | 官方 SDK |
|----------|------------|-----|-----|----------|----------|
| **OpenAI** | GPT-4o 系列原生图片+音频输入；视频抽帧后按图序列输入 | `audio.speech.create`（tts-1 / gpt-4o-mini-tts） | `audio.transcriptions.create`（whisper-1 / gpt-4o-transcribe） | `images.generate`（dall-e-3 / gpt-image-1） | `openai`（TS/Python） |
| **Anthropic** | Claude 系列原生图片输入（含 PDF 页面）；不支持音频输入 | 无官方 TTS | 无官方 STT | 不支持生图 | `@anthropic-ai/sdk` |
| **Google** | Gemini 系列原生图片+音频+视频输入 | Cloud Text-to-Speech（独立云 API） | Cloud Speech-to-Text（独立云 API） | Gemini 原生生图（`imagen`） | `@google/genai` |
| **Replicate** | 托管开源视觉模型（LLaVA、Florence-2 等） | 托管开源 TTS 模型 | 托管 Whisper 大模型 | 托管 Flux / SDXL 等开源模型 | `replicate`（TS/Python） |

> 模型名单会快速迭代——**以官方 SDK 当前支持的模型为准**，不要在代码里写死模型名。上面的模型名只是编写时点的示例。

### 选型原则

1. **官方 SDK 优先**：OpenAI / Anthropic / Google 都有官方 npm 包，模型调用、重试、错误结构都由 SDK 处理。不要手写 `fetch('https://api.openai.com/...')`。
2. **缺什么补什么**：Anthropic 没有 TTS/STT/生图，需要语音或生图时，用 OpenAI 或 Replicate 补位——这正是 Modality Router 存在的意义。
3. **Replicate 是“开源模型托管”**：私有部署 / 开源模型（Flux、Whisper-large、Qwen-VL）走 Replicate 官方 SDK，按次计费，不用自己租 GPU。
4. **音频输入的新趋势**：2026 年旗舰模型开始原生接受音频输入（OpenAI、Google），STT 不再是“必须”——但 Whisper 类专用 STT 在长音频、术语准确率、成本上仍有优势，Router 应支持“原生音频”与“先转写再文本”两条路线。

🤖 **AI 常见错误**：因为 Anthropic 是主模型，就认为“图片理解必须用 Anthropic”。Claude 支持图片输入没错，但生图 / TTS / STT 都要额外 Provider——**把 Provider 能力差异写进 Router 的决策表，而不是写死在代码分支里**。

---


## 1. Modality Router [CUSTOM]

Modality Router 是**业务差异层**：没有任何成熟库知道"你的产品该把图片请求发给哪个模型、纯文字走哪条便宜路线"。决策逻辑因此保留手写——但它**不实现任何 Provider**，只输出一个 `modelId` 字符串，真正的模型调用全部交给官方 SDK。

```typescript
// packages/core/src/multimodality/router.ts —— 只做选型决策 [CUSTOM]
export type ModalityType = 'text' | 'image' | 'audio' | 'screen';

export interface ModalityRoute {
  /** 输入模态（'text' 永远走默认模型，不需要注册） */
  modality: Exclude<ModalityType, 'text'>;
  /** 官方模型/SDK 标识，如 'gpt-4o' / 'whisper-1' / 'tts-1' / 'dall-e-3' */
  modelId: string;
  /** 每千 token 成本，仅用于预算控制 */
  costPer1k: number;
}

export class ModalityRouter {
  private routes = new Map<Exclude<ModalityType, 'text'>, ModalityRoute>();
  private defaultModelId: string;
  /** 上次选型是否回退（调用方可据此告知用户"该模态暂不支持"） */
  lastFallback: string | null = null;

  constructor(defaultModelId: string) {
    this.defaultModelId = defaultModelId;
  }

  register(route: ModalityRoute): void {
    this.routes.set(route.modality, route);
  }

  /** 纯文字永远走最便宜的默认模型 */
  routeFor(input: ModalityType[]): { modelId: string } {
    this.lastFallback = null;
    if (input.length === 1 && input[0] === 'text') {
      return { modelId: this.defaultModelId };
    }
    const needed = input.filter((m): m is Exclude<ModalityType, 'text'> => m !== 'text');
    const key = needed.join('/') as Exclude<ModalityType, 'text'>;
    const route = this.routes.get(key);
    if (route) return { modelId: route.modelId };
    this.lastFallback = `未找到支持 ${key} 的模型，回退到 ${this.defaultModelId}`;
    return { modelId: this.defaultModelId };
  }
}
```

🤖 **AI 常见错误**：把所有请求都发给视觉模型。纯文字请求走视觉模型的 token 费是文字模型的 10 倍以上。必须用 Modality Router 做成本优化——纯文字永远走默认文本模型。

### 决策规则表

Router 的 `routeFor` 背后是一张**业务决策表**。把它从“散落在代码分支里”提升为“显式表格”，产品改路由策略时只改数据不改逻辑：

| 输入模态组合 | 路由目标 | 模型/SDK 示例 | 成本档 | 降级行为 |
|--------------|----------|---------------|--------|----------|
| 纯文字 | 默认文本模型 | 默认 `createModel('openai', ...)` | 最低 | 无（永远可用） |
| 图片 + 文字 | 视觉模型 | OpenAI `gpt-4o` 或 Claude 系列（图片输入） | 高 | 图片压缩后再发（见 2.2） |
| 图片 + 多图对比 | 视觉模型 | 同上，多图 parts | 很高 | 限制单次最多 4 图 |
| 音频（短） | 原生音频模型 | OpenAI / Google 原生音频输入 | 高 | 转 Whisper 文本后走文本 |
| 音频（长/术语多） | STT 转写 + 文本 | `whisper-1` / `gpt-4o-transcribe` | 低 | 转写失败返回错误并提示重录 |
| 屏幕帧 | 视觉模型 | 同图片；帧先压缩到 1280 宽 | 高 | 变化检测为低时跳过（见 5） |
| 图片 + 音频 | 拆分路由 | 图片走视觉模型，音频走 STT | 中 | 任一路失败，整体报错并给出已成功部分 |
| 不支持组合 | 回退默认 | `defaultModelId` | 最低 | 设置 `lastFallback` 并告知用户 |

**路由优先级**：成本优先——能走文本的绝不走视觉；需要视觉时先压缩图片；音频先评估长度与术语量再决定“原生音频”还是“STT+文本”。

### 路由代码扩展

给 `ModalityRouter` 增加两个真实产品需要的能力：**组合键注册**与**成本感知降级**。

```typescript
// packages/core/src/multimodality/router-ext.ts —— 组合路由与成本降级 [CUSTOM]
import type { ModalityType, ModalityRoute } from './router';

export type ModalityCombo = string; // 如 'image/audio'，由 router 的 join 生成

export interface ComboRoute {
  combo: ModalityCombo;
  modelId: string;
  costPer1k: number;
}

export class ComboModalityRouter {
  private combos = new Map<ModalityCombo, ComboRoute>();
  private singles = new Map<ModalityType, ModalityRoute>();
  private defaultModelId: string;
  lastFallback: string | null = null;

  constructor(defaultModelId: string) {
    this.defaultModelId = defaultModelId;
  }

  registerSingle(route: ModalityRoute): void {
    this.singles.set(route.modality, route);
  }

  registerCombo(route: ComboRoute): void {
    this.combos.set(route.combo, route);
  }

  routeFor(input: ModalityType[]): { modelId: string; costPer1k: number } {
    this.lastFallback = null;
    const nonText = input.filter((m): m is Exclude<ModalityType, 'text'> => m !== 'text');
    if (nonText.length === 0) {
      return { modelId: this.defaultModelId, costPer1k: 0 };
    }
    const combo = nonText.join('/');
    const comboRoute = this.combos.get(combo);
    if (comboRoute) return { modelId: comboRoute.modelId, costPer1k: comboRoute.costPer1k };
    if (nonText.length === 1) {
      const single = this.singles.get(nonText[0]);
      if (single) return { modelId: single.modelId, costPer1k: single.costPer1k };
    }
    this.lastFallback = `未找到支持 ${combo} 的路由，回退到 ${this.defaultModelId}`;
    return { modelId: this.defaultModelId, costPer1k: 0 };
  }
}
```

🔗 **工程逻辑**：组合路由是“多模态并存”的必然需求——用户同时发一张图和一段语音时，Router 必须决定“分两条路还是找原生多模态模型”。决策表 + 组合注册让这个逻辑可配置、可测试。`costPer1k` 只用于预算控制与排序，不参与模型调用。

🤖 **AI 常见错误**：用 `if (input.includes('image')) ... else if (input.includes('audio'))` 的链式判断表达路由。模态组合是产品策略，会频繁调整——用表格 + 注册表表达，不要让路由逻辑散落在条件分支里。


---

## 2. 图片理解管线

### 2.1 多模态消息：交给 AI SDK，不手写 `image_url`

Vercel AI SDK 的 `content` parts 原生支持图片（`{ type: 'image', image, mimeType }`），`streamText` / `generateText` 直接消费——**不要手写 OpenAI 的 `image_url` 数组**。

```typescript
// packages/core/src/multimodality/vision.ts —— 只拼业务参数，不写协议
import { generateText } from 'ai';
import { createModel } from '@agentcore/core/llm';

export async function describeImage(
  image: Uint8Array,
  mimeType: string,
  prompt: string,
): Promise<string> {
  const { text } = await generateText({
    model: createModel('openai', process.env as Record<string, string | undefined>),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image', image, mimeType },
        ],
      },
    ],
  });
  return text;
}
```

### 2.2 图片压缩：ffmpeg 一条命令，不写图像算法

4K 照片直接发给视觉 LLM 会浪费 token 和带宽。用系统级 `ffmpeg` 压缩到模型推荐尺寸（最长边 1024），胶水层只负责调用：

```bash
# 压缩到最长边 1024、JPEG 质量 85，保持宽高比
ffmpeg -y -i input.png -vf "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease" -q:v 3 output.jpg
```

```typescript
// packages/core/src/multimodality/image.ts —— 胶水层：只调 ffmpeg，不写图片算法
import { execa } from 'execa';
import { readFile, unlink, writeFile } from 'node:fs/promises';

export async function compressImageForVision(
  input: Buffer,
  maxEdge = 1024,
): Promise<{ data: Buffer; mimeType: string }> {
  const inputPath = `/tmp/agent-image-${Date.now()}-in`;
  const outputPath = `${inputPath}.jpg`;
  await writeFile(inputPath, input);
  try {
    await execa('ffmpeg', [
      '-y',
      '-i', inputPath,
      '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`,
      '-q:v', '3',
      outputPath,
    ]);
    return { data: await readFile(outputPath), mimeType: 'image/jpeg' };
  } finally {
    await unlink(inputPath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
  }
}
```

🔗 **工程逻辑**：图片预处理的"格式选择"是业务规则——照片用 JPEG（有损但体积小），图表用 PNG（无损保留线条锐度）。但**转换本身**是 ffmpeg 的职责，不要用 sharp 手写缩放/编码管线。

### 2.3 音频转码：为 STT 准备输入

浏览器 `MediaRecorder` 默认输出 `audio/webm`，而 Whisper 转写对 mp3 / m4a / wav 的支持最稳。上传前用 ffmpeg 转成 16kHz 单声道 WAV（语音识别最优采样率），同时**削除静音段**减少转写时长与费用：

```bash
# 任意输入格式 → 16kHz 单声道 WAV，静音阈值 -35dB，静音段裁掉 0.2s
ffmpeg -y -i input.webm -af "silenceremove=start_periods=1:start_threshold=-35dB:start_silence=0.2:stop_periods=1:stop_threshold=-35dB:stop_silence=0.2" -ar 16000 -ac 1 output.wav
```

```typescript
// packages/core/src/multimodality/audio.ts —— 音频转码胶水：只调 ffmpeg
import { execa } from 'execa';
import { readFile, unlink, writeFile } from 'node:fs/promises';

export async function transcodeForStt(
  input: Buffer,
  mimeType: string,
): Promise<{ data: Buffer; mimeType: string }> {
  const ext = mimeType === 'audio/webm' ? 'webm' : mimeType.split('/')[1] ?? 'bin';
  const inputPath = `/tmp/agent-audio-${Date.now()}.${ext}`;
  const outputPath = `/tmp/agent-audio-${Date.now()}.wav`;
  await writeFile(inputPath, input);
  try {
    await execa('ffmpeg', [
      '-y', '-i', inputPath,
      '-af', 'silenceremove=start_periods=1:start_threshold=-35dB:start_silence=0.2:stop_periods=1:stop_threshold=-35dB:stop_silence=0.2',
      '-ar', '16000', '-ac', '1', outputPath,
    ]);
    return { data: await readFile(outputPath), mimeType: 'audio/wav' };
  } finally {
    await unlink(inputPath).catch(() => undefined);
    await unlink(outputPath).catch(() => undefined);
  }
}
```

🔗 **工程逻辑**：STT 的准确率与音频格式强相关——16kHz 单声道 WAV 是 Whisper 的最优输入，转码 + 静音裁剪能同时改善准确率与降低成本。**格式选择是业务规则**（录音 / 电话录音 / 视频音轨参数不同），转换本身是 ffmpeg 的职责。

### 2.4 视频抽帧：屏幕录制与视频理解共用

屏幕录制和视频理解的第一步都是“抽帧”。ffmpeg 按间隔抽帧，Agent 只处理关键帧，避免把整段视频发给模型：

```bash
# 每秒抽 1 帧，输出 JPEG 序列（文件名带序号）
ffmpeg -y -i input.mp4 -vf "fps=1" -q:v 4 /tmp/frames/frame-%03d.jpg
```

```typescript
// packages/core/src/multimodality/video.ts —— 视频抽帧胶水：只调 ffmpeg
import { execa } from 'execa';
import { mkdir, readdir, rm } from 'node:fs/promises';

export async function extractFrames(
  videoPath: string,
  fps = 1,
  workdir = `/tmp/agent-frames-${Date.now()}`,
): Promise<string[]> {
  await mkdir(workdir, { recursive: true });
  try {
    await execa('ffmpeg', [
      '-y', '-i', videoPath,
      '-vf', `fps=${fps}`,
      '-q:v', '4',
      `${workdir}/frame-%03d.jpg`,
    ]);
    const files = await readdir(workdir);
    return files.filter((f) => f.endsWith('.jpg')).sort();
  } finally {
    // 调用方读完帧后自行清理；这里只负责目录创建失败时的兜底
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
  }
}
```

> **注意**：`extractFrames` 返回的是**帧文件名列表**，调用方需要自行决定把哪些帧发给视觉模型（例如抽 10 帧只发变化最大的 2 帧）。“发哪几帧”是 Agent 的业务决策，不是 ffmpeg 的职责。

### 2.5 ffmpeg 胶水层统一原则

1. **只做格式转换，不做图像理解**：缩放、裁剪、抽帧是 ffmpeg 的活；“这张图里有没有猫”是视觉模型的活。胶水层不写像素算法。
2. **临时文件必须清理**：`/tmp` 下的中间文件在 `finally` 中删除；进程崩溃残留由系统 `/tmp` 清理策略兜底，但业务代码不能依赖。
3. **命令参数可追溯**：把 ffmpeg 参数写进审计日志（见 8.5），出问题时能复现“这张图当时是怎么压缩的”。
4. **无 ffmpeg 时降级**：检查 `ffmpeg -version` 可用性，缺失时向前端返回明确错误而不是让 Agent 猜测。

🤖 **AI 常见错误**：用 `sharp` 库替代 ffmpeg 做音频转码 / 视频抽帧。sharp 是图片处理库，不处理音视频；混用两个图像库（sharp 压缩 + canvas 缩放）会让输出格式不一致。音频与视频一律走 ffmpeg。


---

## 3. TTS 语音输出

用 **OpenAI 官方 SDK**（`openai` npm 包）的 `audio.speech.create`，不要手写 HTTP 调用。需要声音克隆 / 更高音质时，把 Provider 换成 **ElevenLabs 官方 SDK** 或 **Azure Speech SDK**——接口不同，但都只有"传文本、收音频"两步。

```typescript
// packages/core/src/multimodality/tts.ts —— 只调官方 SDK
import OpenAI from 'openai';

export type TTSVoice = 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';

export async function synthesizeSpeech(
  text: string,
  options: { voice?: TTSVoice; model?: string } = {},
): Promise<Buffer> {
  const client = new OpenAI(); // 读取 OPENAI_API_KEY 环境变量
  const response = await client.audio.speech.create({
    model: options.model ?? 'tts-1',
    voice: options.voice ?? 'alloy',
    input: text,
    response_format: 'mp3',
  });
  return Buffer.from(await response.arrayBuffer());
}
```

**流式播放**：对话式 Agent 的节奏关键——不要等整段文字生成完再合成。在句子边界（`.!?。！？`）切分，每句调用一次 `synthesizeSpeech`，前端拿到音频后立即播放。浏览器端播放用 `<audio>` 或 `AudioContext`（平台 API）。

🤖 **工程逻辑**：TTS 的"首 chunk 延迟"是对话节奏的核心。OpenAI `tts-1` 首包约 200-500ms；如果等 Agent 的全部文字到齐再合成，用户会感觉"AI 沉默了"。**句子级流式**（见 8.2）是默认解法。

---

## 4. STT 语音输入

服务端转写用 **OpenAI 官方 SDK** 的 `audio.transcriptions.create`（Whisper），浏览器端实时识别用 **Web Speech API**（平台能力）。

### 4.1 服务端：Whisper

```typescript
// packages/core/src/multimodality/stt.ts —— 只调官方 SDK
import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';

export async function transcribeAudio(
  audioPath: string,
  options: { language?: string; prompt?: string } = {},
): Promise<{ text: string; language: string }> {
  const client = new OpenAI();
  const transcription = await client.audio.transcriptions.create({
    file: await readFile(audioPath),
    model: 'whisper-1',
    language: options.language,
    prompt: options.prompt, // 上下文词汇提示，改善专有名词识别
  });
  return { text: transcription.text, language: options.language ?? 'unknown' };
}
```

### 4.2 浏览器：Web Speech API

实时语音输入是浏览器原生能力，不需要服务端：

```typescript
// apps/web/src/lib/speech.ts —— 浏览器平台 API，不是轮子
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: (event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void;
  start(): void;
  stop(): void;
}

export function createSpeechRecognition(): SpeechRecognitionLike | null {
  const w = window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  if (!w.webkitSpeechRecognition) return null;
  const recognition = new w.webkitSpeechRecognition();
  recognition.lang = 'zh-CN';
  recognition.continuous = true;
  recognition.interimResults = true;
  return recognition;
}
```

🤖 **工程逻辑**：Web Speech API 的精度低于 Whisper，但零服务端成本、敏感数据不出浏览器。**离线 / 敏感数据场景用 Web Speech API，高精度场景用 Whisper**——两者互补，不是替代。

---

## 5. 屏幕录制 Agent

屏幕录制**不是轮子**：浏览器用 `getDisplayMedia` + `ImageCapture`，Electron 用 `desktopCapturer`——这些都是平台 API。Agent 侧只做两件事：定时截帧、把帧发给视觉模型。

```typescript
// apps/web/src/lib/screenCapture.ts —— 平台 API，不是轮子
import { blobToBase64 } from './media';

export async function captureScreenFrame(): Promise<{ data: string; mimeType: string } | null> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
    return null;
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 1 } });
  const track = stream.getVideoTracks()[0];
  const imageCapture = new ImageCapture(track);
  const bitmap = await imageCapture.grabFrame();

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
  track.stop();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
  if (!blob) return null;
  return { data: await blobToBase64(blob), mimeType: 'image/jpeg' };
}
```

Electron 侧是同一个思路，换成 `desktopCapturer` 拿窗口缩略图：

```typescript
// apps/electron/src/main.ts —— Electron 平台 API
import { desktopCapturer } from 'electron';
import type { BrowserWindow, NativeImage } from 'electron';

export async function captureWindow(): Promise<NativeImage> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  if (sources.length === 0) throw new Error('No screen source');
  return sources[0].thumbnail;
}
```

**变化检测**：如果只想"屏幕变了才通知 Agent"，用成熟库 **pixelmatch** 对比两张缩略图，而不是手写逐像素 diff：

```typescript
// packages/core/src/multimodality/screenDiff.ts —— 变化检测用成熟库
import pixelmatch from 'pixelmatch';

export function diffRatio(a: Buffer, b: Buffer, width: number, height: number): number {
  const diff = pixelmatch(a, b, null, width, height, { threshold: 0.1 });
  return diff / (width * height);
}
```

🔗 **工程逻辑**：屏幕观测链路 = `desktopCapturer` / `getDisplayMedia`（平台采集）→ ffmpeg 压缩 → `describeImage`（视觉模型）。每一段都是成熟方案，Agent 只负责"什么时候截、截完问什么"的业务编排。

🤖 **AI 常见错误**：把屏幕截图直接发云端 LLM 前不提醒用户。`getDisplayMedia` 会捕获整个桌面，可能包含密码管理器等敏感内容。**必须**在首次截屏前弹出隐私提示，并提供敏感区域模糊（客户端 canvas 处理，见 8.3）。

### 敏感区域模糊：客户端处理，敏感数据不出浏览器

屏幕截图发送到云端之前，先在浏览器端对用户标记的敏感区域做模糊。模糊必须在客户端完成，保证“模糊后的图才离开设备”：

```typescript
// apps/web/src/lib/privacyBlur.ts —— 客户端敏感区域模糊（不出浏览器）
export interface BlurRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  radius?: number;
}

export async function blurRegionsOnCanvas(
  source: CanvasImageSource,
  regions: BlurRegion[],
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  canvas.width = typeof source === 'object' && 'width' in source ? source.width : 0;
  canvas.height = typeof source === 'object' && 'height' in source ? source.height : 0;
  ctx.drawImage(source, 0, 0);
  for (const region of regions) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(region.x, region.y, region.width, region.height);
    ctx.clip();
    ctx.filter = `blur(${region.radius ?? 24}px)`;
    ctx.drawImage(source, 0, 0);
    ctx.restore();
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.85);
  });
}
```

🔗 **工程逻辑**：`ctx.filter = 'blur(...px)'` + `clip()` 是浏览器原生能力——先裁剪到敏感区域，再对整图做模糊，等效于“只模糊区域内的像素”。敏感区域由用户圈选（前端交互）或规则配置（如 `x < 200` 的固定区域）提供。

### 合规流程

屏幕录制涉及“用户设备上的数据”，合规是产品责任。最小可行流程：

1. **首次同意**：第一次调用 `getDisplayMedia` 前展示弹窗：“Agent 将看到你选择的屏幕内容，用于 [用途]。敏感区域会被模糊，数据保留 [N] 天。” 用户确认后才启动采集。
2. **会话内提示**：每次会话开始录制时，UI 上显示“正在录屏”的常驻指示条（含停止按钮），避免用户忘记 Agent 仍在看屏幕。
3. **数据最小化**：只发送变化帧（见 pixelmatch 变化检测）；模糊后的图才允许上传；原始帧不落盘。
4. **水印与审计**：发送前在图上叠加“Generated by Agent + 会话 ID”水印，配合 [08-eval-observability.md](./08-eval-observability.md) 记录“哪些帧发给了哪个模型”。
5. **本地处理选项**：敏感场景提供“本地视觉模型”开关——Ollama + LLaVA 在用户机器上完成描述，截图完全不离开设备。隐私要求高时，**默认走本地**。

🤖 **AI 常见错误**：把模糊放在服务端。一旦原图已经上传，服务端模糊只是“减少泄露后的损失”，不能阻止泄露发生——**模糊必须发生在客户端、上传之前**。合规提示文案与 [07-security.md](./07-security.md) 的护栏联动：用户拒绝录屏时，Agent 应降级为纯文本模式，而不是绕过。


---

## 6. 图片生成

图片生成作为 Agent 的 Tool 使用。生成调用走 **OpenAI 官方 SDK** 的 `images.generate`；需要开源模型 / 私有部署时换成 **Replicate 官方 SDK**——两者都是官方客户端，不要手写 HTTP。

```typescript
// packages/core/src/multimodality/imageGeneration.ts —— 官方 SDK
import OpenAI from 'openai';

export async function generateImage(
  prompt: string,
  options: { size?: '1024x1024' | '1792x1024' | '1024x1792'; quality?: 'standard' | 'hd' } = {},
): Promise<Buffer> {
  const client = new OpenAI();
  const result = await client.images.generate({
    model: 'dall-e-3',
    prompt,
    size: options.size ?? '1024x1024',
    quality: options.quality ?? 'standard',
    response_format: 'b64_json',
  });
  const b64 = result.data[0]?.b64_json;
  if (!b64) throw new Error('No image returned');
  return Buffer.from(b64, 'base64');
}
```

把它注册成 AI SDK 的 `tool`，Agent 就能在 ReAct 循环里自主决定"该画图了"：

```typescript
// packages/core/src/agent/tools.ts —— 复用 01 的 tool() 体系
import { tool } from 'ai';
import { z } from 'zod';
import { generateImage } from '../multimodality/imageGeneration';

export const generateImageTool = tool({
  description: '根据提示词生成一张图片，返回 PNG 的 base64 编码',
  parameters: z.object({ prompt: z.string().describe('图片内容描述，尽量具体') }),
  execute: async ({ prompt }) => {
    const png = await generateImage(prompt);
    return { png: png.toString('base64') };
  },
});
```

🔗 **工程逻辑**：图片生成不是独立入口，而是 Agent 的一个工具——用户说"画一只猫"，LLM 看到意图后调用 `generateImageTool`，结果通过 `tool_complete` 事件推给前端。这与 02（Tools & Skills）完全一致，没有额外机制。

---

## 7. 前端：Media Chat

Media Chat 的职责是采集（粘贴图片 / 录音 / 截屏）和渲染（图片、音频、生成图），全部用浏览器平台 API。**注意：浏览器没有 `Buffer`**，base64 转换用 `FileReader` 或 `Uint8Array` + `btoa`，不要 `Buffer.from`。

### 7.1 附件采集与 base64 转换

```typescript
// apps/web/src/lib/media.ts —— 浏览器平台 API
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
```

### 7.2 录音（MediaRecorder）

```typescript
// apps/web/src/hooks/useVoiceRecorder.ts —— MediaRecorder 是平台 API
import { useCallback, useRef, useState } from 'react';
import { blobToBase64 } from '../lib/media';

export function useVoiceRecorder(onRecorded: (base64: string, mimeType: string) => void) {
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    chunksRef.current = [];
    recorder.ondataavailable = (e) => chunksRef.current.push(e.data);
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
      onRecorded(await blobToBase64(blob), 'audio/webm');
      stream.getTracks().forEach((t) => t.stop());
    };
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
  }, [onRecorded]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    setRecording(false);
  }, []);

  return { recording, start, stop };
}
```

### 7.3 渲染：MediaBubble

```tsx
// apps/web/src/components/chat/MediaBubble.tsx
export function MediaBubble({ parts }: { parts: Array<{ type: string; text?: string; base64?: string; mimeType?: string }> }) {
  return (
    <div className="space-y-2">
      {parts.map((part, idx) => {
        if (part.type === 'image' && part.base64) {
          return <img key={idx} src={`data:${part.mimeType ?? 'image/png'};base64,${part.base64}`} alt="图片" className="max-w-xs rounded-lg border" />;
        }
        if (part.type === 'audio' && part.base64) {
          return <audio key={idx} src={`data:${part.mimeType ?? 'audio/webm'};base64,${part.base64}`} controls className="w-full" />;
        }
        if (part.type === 'image-generation' && part.base64) {
          return <img key={idx} src={`data:image/png;base64,${part.base64}`} alt={part.text ?? ''} className="max-w-sm rounded-lg border" />;
        }
        return <p key={idx} className="whitespace-pre-wrap text-sm">{part.text}</p>;
      })}
    </div>
  );
}
```

🤖 **AI 常见错误**：浏览器环境用 `Buffer.from(...)` 转 base64。`Buffer` 是 Node 全局对象，浏览器里会直接 `ReferenceError`。统一用 `FileReader` / `Uint8Array` + `btoa`。

### 7.4 音频播放队列：互斥锁

TTS 流式播放时，多条音频消息可能几乎同时到达。前端维护一个**播放互斥锁**——同一时间只有一个 `<audio>` 在播，新音频到达时打断旧音频：

```typescript
// apps/web/src/hooks/useAudioPlayback.ts —— 播放互斥锁
import { useCallback, useRef } from 'react';

export function useAudioPlayback() {
  const currentRef = useRef<HTMLAudioElement | null>(null);

  const play = useCallback((src: string) => {
    currentRef.current?.pause();
    currentRef.current = new Audio(src);
    void currentRef.current.play().catch(() => undefined);
  }, []);

  const stop = useCallback(() => {
    currentRef.current?.pause();
    currentRef.current = null;
  }, []);

  return { play, stop };
}
```

🔗 **工程逻辑**：`new Audio(src)` 每次创建新实例，`pause()` 旧实例后立即播新的——这就是 8.4 的“互斥锁”落地。不要维护播放队列（等旧音频播完再播新的）：对话场景下新回复优先，旧音频应被丢弃。

### 7.5 粘贴图片自动压缩

用户从剪贴板粘贴截图时，前端先用 canvas 压缩到 1024 再上传，避免大图直接进视觉模型：

```typescript
// apps/web/src/lib/compressPastedImage.ts —— 粘贴图片压缩
export async function compressPastedImage(file: File, maxEdge = 1024): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.85);
  });
}
```

🤖 **AI 常见错误**：压缩后的 `Blob` 类型固定为 JPEG——透明 PNG 会被压成黑底。需要透明度的图片（图表 / 截图带透明区域）用 `image/png` 或 `image/webp`，这是业务规则，别写死在工具函数里。


---

## 8. AI 避坑

### 8.1 多模态 token 消耗暴增

**问题**：一张 4K 照片直接发给视觉 LLM ≈ 2000+ token（仅图片部分），费用是同样长度文字的 20 倍。

**解决**：
1. 前端发送前用 canvas / ffmpeg 压缩到 1024×1024 以内（见第 2 节）。
2. 设置 token 预算上限：单次对话的多模态 token 不超过总预算的 30%。
3. 非必要图片（表情包等）降低分辨率到 512 或走 fast 模式。

### 8.2 TTS 延迟影响对话节奏

**问题**：TTS 等整段文字完成才合成，用户感觉"AI 不说话"。

**解决**：
1. **句子级流式**：在句子边界（`.!?。！？`）切分，每句单独合成播放，第一句 200ms 内开始播放。
2. **预合成**：Agent 生成文字时看到第一个完整句子就开始 TTS（不等全部到齐）。
3. **播放指示器**：合成中显示"正在生成语音..."微动效。

### 8.3 屏幕截图隐私泄露

**问题**：`getDisplayMedia` 捕获整个桌面/窗口，可能包含邮件、密码管理器等敏感信息。

**解决**：
1. 明确提示"Agent 将看到你选择的屏幕内容"。
2. 提供"敏感区域模糊"：客户端 canvas 对指定区域做高斯模糊后再发送。
3. 敏感场景用本地 LLM（Ollama + LLaVA）完全离线处理。
4. 添加水印标识"Generated by Agent"便于审计。

### 8.4 音频消息没播完就发下一条

**问题**：前一条 TTS 还在播放，新消息又触发新 TTS，两个音频交织。

**解决**：前端维护一个**播放互斥锁**——新回复到达时 `audioRef.current.pause()`、清空队列、再播放新音频。`<audio>` 元素每次只保留一个实例。

### 8.5 多模态调用也要可观测性

TTS / STT / 视觉调用是独立 API，不自动出现在模型 trace 里——需要手动记录。每个多模态调用都应在 Langfuse（[08-eval-observability.md](./08-eval-observability.md)）里记一条 span：

```typescript
// packages/core/src/multimodality/observe.ts —— 多模态调用埋点
import type { Span } from '@langfuse/ai';

export interface MultimodalCallMeta {
  operation: 'tts' | 'stt' | 'vision' | 'image-gen';
  modelId: string;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
}

export function attachMultimodalMeta(span: Span, meta: MultimodalCallMeta): void {
  span.setAttributes({
    'gen_ai.operation': meta.operation,
    'gen_ai.request.model': meta.modelId,
    'agentcore.multimodal.input_bytes': meta.inputBytes,
    'agentcore.multimodal.output_bytes': meta.outputBytes,
    'agentcore.multimodal.duration_ms': meta.durationMs,
  });
}
```

> `Span` 类型以 `@langfuse/ai` 当前导出为准；关键是把 `operation` / `modelId` / 字节数记下来，成本归因和故障排查才有依据。

### 8.6 Provider 模型名快速迭代

2026 年的模型名变化以月为单位。`gpt-4o` / `tts-1` / `whisper-1` 会过时，代码里写死模型名等于埋雷：

1. **模型名进配置**：`ModalityRoute.modelId` 从配置/环境变量读取，不硬编码在工具函数里。
2. **保留回退链**：`gpt-4o` → `gpt-4o-mini` → 报错，路由降级而不是崩溃。
3. **升级只改一处**：模型升级时只改 Router 注册表（`registerSingle` / `registerCombo`），不动工具实现。

### 8.7 模态回退必须告知用户

Router 回退到默认模型时，用户可能得到“答非所问”的结果（例如问图片，文本模型说“我看不到图”）。`lastFallback` 不能只留在 Router 内部：

1. 工具返回结构化字段 `fallback: string | null`，随 `tool_complete` 事件发给前端。
2. 前端在消息里显示“该模态暂不支持，已用文本模型回复”的提示。
3. 高价值场景（付费用户）应提示升级或切换 Provider，而不是静默降级。

🤖 **AI 常见错误**：只给 Router 加 `lastFallback` 却从不展示给用户。回退是不可见的错误——用户只会觉得“这个 Agent 看不到我发的图”。把 `fallback` 作为工具返回字段上抛。


---

## 9. 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：运行 `pnpm typecheck`，确认 `packages/core/src/multimodality/*.ts` 与 `apps/web/src/lib/*.ts`、`apps/web/src/hooks/useVoiceRecorder.ts` 全部 0 错误。
- [ ] **图片理解**：给 `describeImage` 传一张 1024×1024 JPEG，断言返回文本包含图中主体描述；`compressImageForVision` 输出体积小于 100KB。
- [ ] **TTS/STT**：`synthesizeSpeech('你好')` 返回可播放的 MP3 buffer；`transcribeAudio` 对一段中文语音返回包含预期句子的文本。
- [ ] **Modality Router**：纯文字请求走 `defaultModelId`；图片请求走视觉模型；无匹配模态时回退并设置 `lastFallback`。
- [ ] **屏幕录制**：浏览器调用 `captureScreenFrame` 返回 base64 JPEG；Electron 端 `captureWindow` 返回非空缩略图；截屏前出现隐私提示。
- [ ] **前端**：粘贴图片自动压缩并显示附件预览；按住录音松开发送；生成图片在气泡内展示并可下载。
- [ ] **Provider 对比**：`## 0` 至少列出 4 家 Provider（OpenAI / Anthropic / Google / Replicate），每行标注多模态输入、TTS/STT、官方 SDK 与生产案例；`providerCapabilities` 中的 `ProviderId` 与 00-types 的 `ModelProvider` 枚举一致。
- [ ] **决策规则表**：ModalityRouter 决策表覆盖纯文本 / 图片 / 音频 / 视频 / 生图 / 混合六种输入，每行对应一个 `[CUSTOM]` 规则分支；`ComboModalityRouter` 的组合键行为（`image+audio` 等）与决策表一致。
- [ ] **ffmpeg 胶水**：`transcodeToWav` 能把 webm 转成 16kHz 单声道 WAV 并返回 `{ data, durationMs }`；`extractFrames` 对 10 秒视频每 2 秒抽 1 帧，返回 5 个 `Buffer`。
- [ ] **隐私合规**：屏幕录制前出现首次同意对话框；`blurRegionsOnCanvas` 对指定坐标区域做高斯模糊；会话提示条、数据最小化、水印审计、本地 Ollama + LLaVA 离线路径均可用。
- [ ] **播放互斥锁**：连发两条音频消息时，第二条会 `pause()` 第一条并清空队列，页面上同一时刻只有一个 `<audio>` 实例。
- [ ] **可观测性**：TTS / STT / 视觉调用均写入 Langfuse span，`attachMultimodalMeta` 至少记录 operation / modelId / durationMs / inputBytes / outputBytes 五个属性。
- [ ] **回退告知**：触发模态回退时工具返回 `fallback` 字段，前端消息气泡显示“该模态暂不支持”的提示；不静默降级。
- [ ] **模型名配置化**：`ModalityRoute.modelId` 全部从配置读取，代码中不存在写死的 `gpt-4o` / `whisper-1` 字面量（8.6 回归）。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 标记与本层验收清单。

---

> **与后续节点的衔接**：本层的 `describeImage`、`synthesizeSpeech`、`transcribeAudio` 都返回简单数据类型（`string` / `Buffer`），可被任意编排层复用。02 可把 `generateImageTool` 注册进 ToolRegistry；07 按 8.3 的隐私合规清单对屏幕截图做脱敏与水印，并把敏感区域模糊配置纳入 secret 管理；08 用 Langfuse 追踪每次 TTS / STT / 视觉调用的延迟与成本（span 属性见 8.5）；21 把屏幕观测与音频播放加入故障恢复链路——TTS 失败时走 8.7 的回退告知而不是静默降级；22 用决策表与 `fallback` 字段支撑守护链路；23 把 `captureScreenFrame` 的截图作为 computer-use 人工复核证据归档。所有模态的 `llm` 类型仍遵循 00 契约——图片理解走 `LanguageModel`，音频 / 生图走官方 SDK，不引入自定义 LLM 抽象；Provider 模型名迭代按 8.6 只改 Router 注册表一处。

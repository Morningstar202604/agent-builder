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

---

## 9. 本层验收清单

> 完成本层后，用以下步骤验证：

- [ ] **类型检查**：运行 `pnpm typecheck`，确认 `packages/core/src/multimodality/*.ts` 与 `apps/web/src/lib/*.ts`、`apps/web/src/hooks/useVoiceRecorder.ts` 全部 0 错误。
- [ ] **图片理解**：给 `describeImage` 传一张 1024×1024 JPEG，断言返回文本包含图中主体描述；`compressImageForVision` 输出体积小于 100KB。
- [ ] **TTS/STT**：`synthesizeSpeech('你好')` 返回可播放的 MP3 buffer；`transcribeAudio` 对一段中文语音返回包含预期句子的文本。
- [ ] **Modality Router**：纯文字请求走 `defaultModelId`；图片请求走视觉模型；无匹配模态时回退并设置 `lastFallback`。
- [ ] **屏幕录制**：浏览器调用 `captureScreenFrame` 返回 base64 JPEG；Electron 端 `captureWindow` 返回非空缩略图；截屏前出现隐私提示。
- [ ] **前端**：粘贴图片自动压缩并显示附件预览；按住录音松开发送；生成图片在气泡内展示并可下载。
- [ ] **门禁回归**：运行 `node tools/check-skill.mjs`，本文件所有代码块通过语法解析，且包含 ≥3 条 🤖 标记与本层验收清单。

---

> **与后续节点的衔接**：本层的 `describeImage`、`synthesizeSpeech`、`transcribeAudio` 都返回简单数据类型（`string` / `Buffer`），可被任意编排层复用。02 可把 `generateImageTool` 注册进 ToolRegistry；08 可用 Langfuse 追踪每次 TTS/STT 调用的延迟与成本；21 可把屏幕观测加入故障恢复链路。所有模态的 `llm` 类型仍遵循 00 契约——图片理解走 `LanguageModel`，音频/生图走官方 SDK，不引入自定义 LLM 抽象。

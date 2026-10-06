# 16 — 多模态 Agent · 图片/语音/屏幕

> 本 reference 覆盖现代 Agent 超越纯文本的完整多模态能力——图片理解、TTS 语音输出、STT 语音输入、屏幕录制观测、图片生成。读完本文件可独立落地 Modality Router、媒体处理管线、前端 Media Chat 组件的全部后端 + 前端代码。

---

## 目录

- [工程逻辑：多模态 Agent 架构](#工程逻辑多模态-agent-架构)
- [1. Modality Router](#1-modality-router)
- [2. 图片理解管线](#2-图片理解管线)
- [3. TTS 集成](#3-tts-集成)
- [4. STT 语音输入](#4-stt-语音输入)
- [5. 屏幕录制 Agent](#5-屏幕录制-agent)
- [6. 图片生成](#6-图片生成)
- [7. 前端：Media Chat](#7-前端media-chat)
- [8. AI 避坑](#8-ai-避坑)

---

## 工程逻辑：多模态 Agent 架构

现代 Agent 不只是"文字输入 → 文字输出"。用户拍一张图问"这是什么？"、用语音输入、要求 Agent 朗读回答、甚至让 Agent 观测屏幕变化——这些是多模态 Agent 的必备能力。

核心设计挑战：**不是所有模型都支持所有模态**。Claude 可以看图但不能生图，DALL-E 能生图但不能看屏幕截图。需要一个 Modality Router 把不同模态的请求分发到正确的模型。

```
┌─────────────────────────────────────────────────────────────────┐
│                  多模态 Agent 架构                                 │
│                                                                   │
│  ┌────────────┐     ┌────────────┐     ┌────────────┐          │
│  │  语音输入   │     │  文字输入   │     │  图片输入   │          │
│  │  (STT)     │     │  (Text)    │     │  (Vision)  │          │
│  └─────┬──────┘     └─────┬──────┘     └─────┬──────┘          │
│        │                  │                  │                    │
│        ▼                  ▼                  ▼                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Modality Router                                │  │
│  │  根据输入模态选择模型：                                       │  │
│  │  - 图片+文字 → GPT-4V / Claude 3.5 Vision                   │  │
│  │  - 纯文字 → GPT-4 / Claude（按需）                           │  │
│  │  - 屏幕截图 → GPT-4V + 对比分析                              │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                       │
│                           ▼                                       │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Agent Core Loop                                 │  │
│  │  (来自 01-foundation.md)                                     │  │
│  └────────────────────────┬───────────────────────────────────┘  │
│                           │                                       │
│              ┌────────────┼────────────┐                         │
│              ▼            ▼            ▼                         │
│       ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│       │  TTS     │ │  图片生成 │ │  纯文字   │                   │
│       │ (语音输出)│ │ (DALL-E) │ │  (Text)  │                   │
│       └──────────┘ └──────────┘ └──────────┘                   │
└─────────────────────────────────────────────────────────────────┘
```

**关键设计原则**：
1. **模态透明**：Agent Core 不关心输入是文字还是图片，只需在消息中标记模态类型。Modality Router 负责选模型。
2. **渐进增强**：去掉多模态能力，Agent 仍然正常工作（退化为纯文本 Agent）。
3. **资源可控**：多模态 token 消耗暴增。图片压缩、流式播放、限流都是必要的。

---

## 1. Modality Router

```typescript
// packages/core/src/multimodality/router.ts

export type ModalityType = 'text' | 'image' | 'audio' | 'screen';

export interface ModalityCapability {
  inputTypes: ModalityType[];
  outputTypes: ModalityType[];
  modelId: string;
  contextWindow: number;
  /** 每 token 成本（用于预算控制） */
  costPerToken: number;
}

/**
 * Modality Router —— 根据输入模态选择最合适的模型
 *
 * 工程选择：
 * - 不是"一个模型搞定所有"，而是按模态能力注册表选最合适的
 * - 纯文字用便宜快速的模型，图片用视觉模型
 * - 成本意识：纯文字请求不走视觉模型计费
 */
export class ModalityRouter {
  private models = new Map<string, ModalityCapability>();
  private defaultModel: string;

  constructor(defaultModel: string) {
    this.defaultModel = defaultModel;
  }

  /** 注册模型能力 */
  registerModel(capability: ModalityCapability): void {
    this.models.set(capability.modelId, capability);
  }

  /**
   * 根据输入模态选模型
   * 选择逻辑：
   * 1. 过滤出支持所有所需输入模态的模型
   * 2. 在满足条件的模型中，按成本选最便宜的
   * 3. 没有匹配的，回退到 defaultModel（假设 defaultModel 是"全能模型"）
   */
  selectModel(inputModalities: ModalityType[]): string {
    if (inputModalities.length === 1 && inputModalities[0] === 'text') {
      return this.defaultModel; // 纯文字走最便宜路线
    }

    let bestModel: string | null = null;
    let bestCost = Infinity;

    for (const [modelId, cap] of this.models) {
      const supportsAll = inputModalities.every(m => cap.inputTypes.includes(m));
      if (supportsAll && cap.costPerToken < bestCost) {
        bestCost = cap.costPerToken;
        bestModel = modelId;
      }
    }

    return bestModel || this.defaultModel;
  }

  /**
   * 构建多模态消息内容
   * OpenAI Vision API 格式：[{type: "text", text: "..."}, {type: "image_url", image_url: {url: "..."}}]
   */
  static buildMultimodalContent(
    text: string,
    images?: Array<{ data: string; mimeType: string }>
  ): Array<{ type: string; text?: string; image_url?: { url: string } }> {
    const content: any[] = [{ type: 'text', text }];

    if (images) {
      for (const img of images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: `data:${img.mimeType};base64,${img.data}`,
          },
        });
      }
    }

    return content;
  }

  /**
   * 估算多模态消息的 token 用量
   * 关键：图片 token 不是按 byte 算，而是按"视觉 token"计算
   * OpenAI: 512x512 图片 ≈ 170 tokens；2048x2048 ≈ 850+ tokens
   */
  static estimateTokenCount(
    text: string,
    images?: Array<{ width: number; height: number }>
  ): number {
    const textTokens = Math.ceil(text.length / 3); // 粗估
    let imageTokens = 0;

    if (images) {
      for (const img of images) {
        // 按面积比例估算（以 512x512 = 170 token 为基准）
        const scale = Math.ceil(img.width / 512) * Math.ceil(img.height / 512);
        imageTokens += 85 + 170 * scale; // base + scaled
      }
    }

    return textTokens + imageTokens;
  }
}
```

> 🤖 **AI 常见错误**：把所有请求都发给 GPT-4V（视觉模型）。纯文字请求走视觉模型的 token 费是文字模型的 10 倍以上。必须用 Modality Router 做成本优化。

---

## 2. 图片理解管线

```typescript
// packages/core/src/multimodality/imagePipeline.ts

import sharp from 'sharp';

export interface ImageProcessingOptions {
  maxWidth?: number;        // 默认 1024
  maxHeight?: number;       // 默认 1024
  quality?: number;         // JPEG 质量 1-100，默认 80
  format?: 'jpeg' | 'png' | 'webp';
}

/**
 * 图片预处理管线
 *
 * 工程逻辑：
 * - 原始图片（4K 照片 = 几 MB）直接发送给视觉 LLM：浪费 token、浪费带宽、浪费时间
 * - 正确做法：缩放到模型优化尺寸（通常 512x512 或 1024x1024），有损压缩到 100KB 以下
 * - sharp 是 Node.js 最高性能图片处理库（底层 libvips）
 */
export class ImageProcessingPipeline {
  private options: Required<ImageProcessingOptions>;

  constructor(options?: ImageProcessingOptions) {
    this.options = {
      maxWidth: options?.maxWidth ?? 1024,
      maxHeight: options?.maxHeight ?? 1024,
      quality: options?.quality ?? 80,
      format: options?.format ?? 'jpeg',
    };
  }

  /**
   * 处理图片：缩放 + 压缩 + base64 编码
   * 返回可直接发送的多模态内容格式
   */
  async process(buffer: Buffer, mimeType: string): Promise<{
    base64: string;
    mimeType: string;
    originalSize: number;
    processedSize: number;
    width: number;
    height: number;
  }> {
    let image = sharp(buffer);
    const metadata = await image.metadata();

    // 只在图片超过限制时才缩放
    const needsResize = (metadata.width && metadata.width > this.options.maxWidth) ||
                        (metadata.height && metadata.height > this.options.maxHeight);

    if (needsResize) {
      image = image.resize(this.options.maxWidth, this.options.maxHeight, {
        fit: 'inside',      // 保持比例，不拉伸
        withoutEnlargement: true, // 小图不放大
      });
    }

    // 格式转换 + 压缩
    let processed: Buffer;
    let outputMimeType: string;

    switch (this.options.format) {
      case 'webp':
        processed = await image.webp({ quality: this.options.quality }).toBuffer();
        outputMimeType = 'image/webp';
        break;
      case 'png':
        processed = await image.png({ quality: this.options.quality }).toBuffer();
        outputMimeType = 'image/png';
        break;
      default:
        processed = await image.jpeg({ quality: this.options.quality }).toBuffer();
        outputMimeType = 'image/jpeg';
    }

    const processedMeta = await sharp(processed).metadata();

    return {
      base64: processed.toString('base64'),
      mimeType: outputMimeType,
      originalSize: buffer.length,
      processedSize: processed.length,
      width: processedMeta.width || 0,
      height: processedMeta.height || 0,
    };
  }

  /**
   * 计算压缩比
   */
  static compressionRatio(originalSize: number, processedSize: number): string {
    const ratio = ((1 - processedSize / originalSize) * 100).toFixed(1);
    return `${ratio}%`;
  }
}
```

> 🤖 **工程逻辑**：图片预处理不只是"变小"，还要考虑。
> 1. **格式选择**：照片用 JPEG/WEBG（有损但体积极小），图表用 PNG（无损保留线条锐度）。
> 2. **保持比例**：不要拉伸图片，否则 LLM 会看到变形的内容。
> 3. **不放大小图**：32x32 的图标放大到 512 不会增加信息量，只会浪费 token。

---

## 3. TTS 集成

```typescript
// packages/core/src/multimodality/tts.ts

/**
 * TTS Provider 接口
 *
 * 工程选型：
 * - ElevenLabs：音质最高，支持声音克隆，延迟 ~200-500ms（首 chunk）
 * - Azure Speech：稳定可靠，中文支持好，企业合规首选
 * - OpenAI TTS：价格最低，集成最简单（如果已经用 OpenAI）
 * - 建议实现 Provider 模式，运行时切换
 */
export interface TTSProvider {
  synthesize(text: string, options?: TTSOptions): Promise<TTSResult>;
  /** 流式合成 —— 返回 AsyncGenerator，首 chunk 更快 */
  synthesizeStream(text: string, options?: TTSOptions): AsyncGenerator<TTSChunk>;
  getVoiceList(): Promise<VoiceInfo[]>;
}

export interface TTSOptions {
  voice?: string;
  speed?: number;           // 0.5 - 2.0
  pitch?: number;
  format?: 'mp3' | 'opus' | 'pcm';
  language?: string;
}

export interface TTSResult {
  audioData: Buffer;
  duration: number;         // 毫秒
  format: string;
  sampleRate: number;
}

export interface TTSChunk {
  audioData: Buffer;
  isLast: boolean;
  /** 此 chunk 对应文本的字符偏移量，用于字幕同步 */
  textOffset: number;
  textLength: number;
}

export interface VoiceInfo {
  id: string;
  name: string;
  language: string;
  gender: 'male' | 'female';
  previewUrl?: string;
}

/**
 * ElevenLabs TTS 实现
 *
 * 关键特性：
 * - 支持 streaming：边合成边播放，不需要等整个音频完成
 * - 首 audio chunk 延迟 ~200ms（vs 非流式 ~1-2s）
 * - 默认 voice："Rachel"（英文）、"Adam"（中文）
 */
export class ElevenLabsTTSProvider implements TTSProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.elevenlabs.io/v1';
  }

  async synthesize(text: string, options?: TTSOptions): Promise<TTSResult> {
    const voiceId = options?.voice || '21m00Tcm4TlvDq8ikWAM'; // Rachel

    const res = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true,
        },
      }),
    });

    if (!res.ok) throw new Error(`ElevenLabs TTS failed: ${res.status}`);

    const audioData = Buffer.from(await res.arrayBuffer());
    return {
      audioData,
      duration: this.estimateDuration(text),
      format: 'mp3',
      sampleRate: 44100,
    };
  }

  async *synthesizeStream(text: string, options?: TTSOptions): AsyncGenerator<TTSChunk> {
    const voiceId = options?.voice || '21m00Tcm4TlvDq8ikWAM';

    const res = await fetch(`${this.baseUrl}/text-to-speech/${voiceId}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!res.ok) throw new Error(`ElevenLabs TTS stream failed: ${res.status}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    let offset = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      yield {
        audioData: Buffer.from(value),
        isLast: false,
        textOffset: offset,
        textLength: Math.floor(value.length / 100), // 粗略估算
      };
      offset += Math.floor(value.length / 100);
    }
  }

  async getVoiceList(): Promise<VoiceInfo[]> {
    const res = await fetch(`${this.baseUrl}/voices`, {
      headers: { 'xi-api-key': this.apiKey },
    });
    if (!res.ok) return [];

    const data = await res.json();
    return data.voices.map((v: any) => ({
      id: v.voice_id,
      name: v.name,
      language: v.labels?.language || 'en',
      gender: v.labels?.gender || 'female',
      previewUrl: v.preview_url,
    }));
  }

  private estimateDuration(text: string): number {
    // 英文约每秒 15 字，中文约每秒 4 字
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return (chineseChars / 4 + otherChars / 15) * 1000;
  }
}

/**
 * TTS 编排器 —— 缓冲区 + 队列 + 流控
 *
 * 设计决策：
 * - TTS 在 Agent 回复的中途就开始合成（不等所有文字到齐）
 * - 维护一个播放队列，确保不重读、不漏读
 * - 当用户发送新消息时，立即停止当前播放（中断）
 */
export class TTSManger {
  private provider: TTSProvider;
  private isPlaying = false;
  private queue: string[] = [];
  private abortController: AbortController | null = null;

  constructor(provider: TTSProvider) {
    this.provider = provider;
  }

  /**
   * 流式播放文本
     * 由 Agent 的 SSE 流驱动：每收到一段完整文本，就开始合成
   */
  async speakStream(textStream: AsyncGenerator<string>): Promise<void> {
    this.isPlaying = true;
    this.abortController = new AbortController();

    try {
      for await (const textChunk of textStream) {
        if (this.abortController.signal.aborted) break;

        const result = await this.provider.synthesize(textChunk);
        await this.playAudio(result.audioData);
      }
    } finally {
      this.isPlaying = false;
    }
  }

  /** 立即停止播放 */
  stop(): void {
    this.abortController?.abort();
    this.isPlaying = false;
    this.queue = [];
  }

  private async playAudio(audioData: Buffer): Promise<void> {
    // 实际播放由前端 AudioContext 或 <audio> 元素完成
    // 这里只做缓冲区管理
    this.queue.push(audioData.toString('base64'));
  }
}
```

> 🤖 **工程逻辑**：TTS 流式播放是对话式 Agent 的"节奏关键"。合成的首 chunk 必须在用户感知的"可接受延迟"内（<300ms）。ElevenLabs 的 streaming endpoint 比普通 endpoint 快 50%，是对话场景的默认选择。

---

## 4. STT 语音输入

```typescript
// packages/core/src/multimodality/stt.ts

/**
 * STT Provider 接口
 *
 * 工程选型：
 * - Whisper API (OpenAI)：云端，精度高，支持 99 种语言
 * - Whisper.cpp (本地)：离线，延迟 <100ms（GPU），但首次加载慢
 * - Azure Speech-to-Text：中文准确率最高
 * - Web Speech API (浏览器原生)：零依赖，但精度一般
 */
export interface STTProvider {
  transcribe(audioBuffer: Buffer, options?: STTOptions): Promise<STTResult>;
}

export interface STTOptions {
  language?: string;
  prompt?: string;                    // 上下文短语提示（改善专有名词识别）
  temperature?: number;
  responseFormat?: 'text' | 'json' | 'verbose_json';
}

export interface STTResult {
  text: string;
  language: string;
  duration: number;
  confidence: number;
  /** 词级别时间戳（可选，前端用于高亮同步） */
  wordTimestamps?: Array<{ word: string; start: number; end: number }>;
}

/**
 * Whisper API 实现
 *
 * 关键参数：
 * - initial_prompt：提供上下文词汇列表，改善专业术语识别
 * - response_format：verbose_json 返回时间戳，用于前端的字幕同步
 */
export class WhisperSTTProvider implements STTProvider {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl || 'https://api.openai.com/v1';
  }

  async transcribe(audioBuffer: Buffer, options?: STTOptions): Promise<STTResult> {
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer]), 'audio.webm');
    formData.append('model', 'whisper-1');

    if (options?.language) formData.append('language', options.language);
    if (options?.prompt) formData.append('prompt', options.prompt);
    if (options?.temperature !== undefined) formData.append('temperature', String(options.temperature));
    if (options?.responseFormat) formData.append('response_format', options.responseFormat);

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: formData,
    });

    if (!res.ok) throw new Error(`Whisper API error: ${res.status}`);

    const data = await res.json();

    return {
      text: data.text || '',
      language: data.language || 'unknown',
      duration: data.duration || 0,
      confidence: data.segments?.reduce((sum: number, s: any) =>
        sum + (s.avg_logprob || 0), 0) / (data.segments?.length || 1),
      wordTimestamps: data.words?.map((w: any) => ({
        word: w.word,
        start: w.start,
        end: w.end,
      })),
    };
  }
}

/**
 * 浏览器原生 Web Speech API 实现（零服务端调用）
 *
 * 适合：快速集成、离线场景、敏感数据不上传
 * 局限：Chrome 支持最好，Firefox/Safari 有限制
 */
export class WebSpeechSTTProvider implements STTProvider {
  private recognition: any;
  private isListening = false;

  constructor() {
    if (typeof window !== 'undefined' && 'webkitSpeechRecognition' in window) {
      const SpeechRecognition = (window as any).webkitSpeechRecognition;
      this.recognition = new SpeechRecognition();
    }
  }

  /**
   * Web Speech API 是流式 API，与 async/await 模式不同
   * 这里封装为单次录音转写接口
   */
  async transcribe(audioBuffer: Buffer, options?: STTOptions): Promise<STTResult> {
    // Web Speech API 不支持直接传入 audio buffer
    // 实际实现需要 MediaRecorder API 实时录音
    // 这里提供接口定义
    return {
      text: '',
      language: options?.language || 'en',
      duration: 0,
      confidence: 0,
    };
  }

  /** 开始实时语音识别（流式返回中间结果） */
  startStreaming(onResult: (text: string, isFinal: boolean) => void, language = 'zh-CN'): void {
    if (!this.recognition) return;

    this.recognition.lang = language;
    this.recognition.continuous = true;
    this.recognition.interimResults = true;

    this.recognition.onresult = (event: any) => {
      let interimText = '';
      let finalText = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalText += transcript;
        } else {
          interimText += transcript;
        }
      }

      if (finalText) onResult(finalText, true);
      else if (interimText) onResult(interimText, false);
    };

    this.recognition.start();
    this.isListening = true;
  }

  stopStreaming(): void {
    if (this.recognition && this.isListening) {
      this.recognition.stop();
      this.isListening = false;
    }
  }
}
```

---

## 5. 屏幕录制 Agent

```typescript
// packages/core/src/multimodality/screenRecording.ts

/**
 * 屏幕录制 Agent —— 定时截图，对比变化，触发 Agent 决策
 *
 * 使用场景：
 * - 监控仪表盘：定时截图，检测异常指标
 * - 自动化测试：截图对比，验证 UI 变更
 * - 辅助操作：Agent"看"屏幕后给出操作建议
 *
 * 工程选择：
 * - 浏览器端用 `getDisplayMedia` API
 * - Electron 端用 `desktopCapturer`
 * - Node 端用 puppeteer/playwright 的 screenshot
 */
export class ScreenRecorder {
  private intervalMs: number;
  private threshold: number;          // 像素变化阈值（0-1），低于此值认为无变化
  private onSignificantChange: (screenshot: Buffer, diff: number) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFrame: Buffer | null = null;

  constructor(options: {
    intervalMs?: number;            // 默认 2000ms
    threshold?: number;             // 默认 0.05 (5%)
    onSignificantChange: (screenshot: Buffer, diff: number) => void;
  }) {
    this.intervalMs = options.intervalMs ?? 2000;
    this.threshold = options.threshold ?? 0.05;
    this.onSignificantChange = options.onSignificantChange;
  }

  /** 启动定时截图 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      try {
        const frame = await this.capture();
        if (this.lastFrame) {
          const diff = await this.compareFrames(this.lastFrame, frame);
          if (diff > this.threshold) {
            this.onSignificantChange(frame, diff);
          }
        }
        this.lastFrame = frame;
      } catch (error) {
        console.error('Screen capture failed:', error);
      }
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 截图——具体实现取决于运行环境 */
  private async capture(): Promise<Buffer> {
    // 浏览器环境
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getDisplayMedia) {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 } as any,
      });
      const track = stream.getVideoTracks()[0];
      const imageCapture = new (window as any).ImageCapture(track);
      const bitmap = await imageCapture.grabFrame();

      // 转换为 buffer
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      track.stop();

      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.8)
      );
      return Buffer.from(await blob.arrayBuffer());
    }

    // Electron 环境
    if (typeof window !== 'undefined' && (window as any).electron?.screenCapture) {
      return (window as any).electron.screenCapture();
    }

    throw new Error('No screen capture method available');
  }

  /**
   * 帧对比——简单像素差分
   * 生产级可用结构化相似性（SSIM）算法替代
   */
  private async compareFrames(frameA: Buffer, frameB: Buffer): Promise<number> {
    const sharp = await import('sharp');

    const [metaA, metaB] = await Promise.all([
      sharp.default(frameA).metadata(),
      sharp.default(frameB).metadata(),
    ]);

    if (metaA.width !== metaB.width || metaA.height !== metaB.height) {
      return 1.0; // 尺寸变化视为完全不同
    }

    // 缩缩略图后做逐像素比较（减少计算量）
    const size = 64;
    const [bufA, bufB] = await Promise.all([
      sharp.default(frameA).resize(size, size).raw().toBuffer(),
      sharp.default(frameB).resize(size, size).raw().toBuffer(),
    ]);

    let diffSum = 0;
    for (let i = 0; i < bufA.length; i++) {
      diffSum += Math.abs(bufA[i] - bufB[i]);
    }

    return diffSum / (bufA.length * 255);
  }
}
```

---

## 6. 图片生成

```typescript
// packages/core/src/multimodality/imageGeneration.ts

export type ImageGenProvider = 'openai' | 'stability' | 'midjourney';

export interface ImageGenOptions {
  prompt: string;
  width?: number;
  height?: number;
  quality?: 'standard' | 'hd';
  style?: 'natural' | 'vivid';
  count?: number;
}

export interface ImageGenResult {
  url?: string;
  base64?: string;
  revisedPrompt?: string;      // DALL-E 会优化 prompt
}

/**
 * 图片生成 Agent —— 让 Agent 能"画图"
 *
 * 设计决策：
 * - 作为 Agent 的 Tool 使用（不是独立入口）
 * - Agent 观察到用户需要图片时，调用 generateImage tool
 * - Agent 生成的图片消息通过 SSE 推送到前端
 *
 * 工程选型：
 * - OpenAI DALL-E 3：质量最高，prompt 遵循度最好
 * - Stability AI：开源可私有部署，成本更低
 * - Midjourney：审美最佳，但 API 非官方（需第三方代理）
 */
export class ImageGenerationProvider {
  private provider: ImageGenProvider;
  private apiKey: string;

  constructor(provider: ImageGenProvider, apiKey: string) {
    this.provider = provider;
    this.apiKey = apiKey;
  }

  async generate(options: ImageGenOptions): Promise<ImageGenResult[]> {
    switch (this.provider) {
      case 'openai':
        return this.generateDALLE(options);
      case 'stability':
        return this.generateStability(options);
      default:
        throw new Error(`Unsupported provider: ${this.provider}`);
    }
  }

  private async generateDALLE(options: ImageGenOptions): Promise<ImageGenResult[]> {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'dall-e-3',
        prompt: options.prompt,
        n: options.count || 1,
        size: `${options.width || 1024}x${options.height || 1024}`,
        quality: options.quality || 'standard',
        style: options.style || 'natural',
        response_format: 'b64_json',
      }),
    });

    if (!res.ok) throw new Error(`DALL-E API error: ${res.status}`);
    const data = await res.json();

    return data.data.map((item: any) => ({
      base64: item.b64_json,
      revisedPrompt: item.revised_prompt,
    }));
  }

  private async generateStability(options: ImageGenOptions): Promise<ImageGenResult[]> {
    const res = await fetch('https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text_prompts: [{ text: options.prompt }],
        width: options.width || 1024,
        height: options.height || 1024,
        samples: options.count || 1,
      }),
    });

    if (!res.ok) throw new Error(`Stability AI error: ${res.status}`);
    const data = await res.json();

    return data.artifacts.map((item: any) => ({
      base64: item.base64,
    }));
  }
}
```

---

## 7. 前端：Media Chat

### 7.1 MediaChatInput

```tsx
// apps/web/src/components/chat/MediaChatInput.tsx

import { useState, useRef, useCallback } from 'react';

interface MediaChatInputProps {
  onSend: (content: string, attachments?: Attachment[]) => void;
}
interface Attachment {
  type: 'image' | 'audio' | 'screen';
  data: string;             // base64
  mimeType: string;
  name: string;
}

/**
 * MediaChatInput —— 支持文字 + 语音 + 图片粘贴 + 屏幕区域选择
 *
 * 特性：
 * - Cmd+V 粘贴图片：自动压缩后作为 attachment
 * - 语音按钮：按住录音，松开发送（类似微信）
 * - 屏幕按钮：调用 getDisplayMedia 捕获区域
 * - 文字输入：保持原有的文本发送能力
 */
export function MediaChatInput({ onSend }: MediaChatInputProps) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  /** 处理粘贴事件——捕捉图片 */
  const handlePaste = useCallback(async (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          // 压缩图片
          const compressed = await compressImage(file, 1024, 1024, 0.8);
          setAttachments(prev => [...prev, {
            type: 'image',
            data: compressed.base64,
            mimeType: compressed.mimeType,
            name: `paste-${Date.now()}.jpg`,
          }]);
        }
      }
    }
  }, []);

  /** 开始录音 */
  const startRecording = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorderRef.current = mediaRecorder;
    audioChunksRef.current = [];

    mediaRecorder.ondataavailable = (e) => {
      audioChunksRef.current.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
      blob.arrayBuffer().then(buffer => {
        setAttachments(prev => [...prev, {
          type: 'audio',
          data: Buffer.from(buffer).toString('base64'),
          mimeType: 'audio/webm',
          name: `voice-${Date.now()}.webm`,
        }]);
      });
      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start();
    setIsRecording(true);
  }, []);

  /** 停止录音 */
  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  /** 屏幕捕获 */
  const handleScreenCapture = useCallback(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 } as any,
    });
    const track = stream.getVideoTracks()[0];
    const ImageCapture = (window as any).ImageCapture;
    const imageCapture = new ImageCapture(track);
    const bitmap = await imageCapture.grabFrame();

    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    track.stop();

    canvas.toBlob(blob => {
      blob!.arrayBuffer().then(buffer => {
        setAttachments(prev => [...prev, {
          type: 'screen',
          data: Buffer.from(buffer).toString('base64'),
          mimeType: 'image/png',
          name: `screen-${Date.now()}.png`,
        }]);
      });
    }, 'image/png');
  }, []);

  const handleSend = () => {
    const trimmedText = text.trim();
    if (!trimText && attachments.length === 0) return;
    onSend(trimmedText, attachments.length > 0 ? attachments : undefined);
    setText('');
    setAttachments([]);
  };

  return (
    <div className="relative">
      {/* 附件预览 */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 px-2">
          {attachments.map((att, idx) => (
            <div key={idx} className="relative group">
              {att.type === 'image' || att.type === 'screen' ? (
                <img
                  src={`data:${att.mimeType};base64,${att.data}`}
                  alt={att.name}
                  className="w-16 h-16 object-cover rounded border border-border"
                />
              ) : (
                <div className="w-16 h-16 rounded border border-border flex items-center justify-center bg-surface">
                  🎤
                </div>
              )}
              <button
                onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 输入区域 */}
      <div className="flex items-end gap-2 p-3 rounded-xl bg-surface border border-border">
        {/* 屏幕捕获 */}
        <button
          onClick={handleScreenCapture}
          className="p-2 rounded-lg hover:bg-border/50 transition-colors"
          title="捕获屏幕"
        >
          🖥️
        </button>

        {/* 语音录制 */}
        <button
          onMouseDown={startRecording}
          onMouseUp={stopRecording}
          onTouchStart={startRecording}
          onTouchEnd={stopRecording}
          className={`p-2 rounded-lg transition-colors ${
            isRecording ? 'bg-red-500/20 text-red-400 animate-pulse' : 'hover:bg-border/50'
          }`}
          title={isRecording ? '松开发送' : '按住说话'}
        >
          {isRecording ? '🔴' : '🎤'}
        </button>

        {/* 文字输入 */}
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onPaste={handlePaste}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="输入消息...（Cmd+V 粘贴图片）"
          className="flex-1 resize-none bg-transparent outline-none text-sm placeholder:opacity-40 max-h-32"
          rows={1}
        />

        {/* 发送 */}
        <button
          onClick={handleSend}
          disabled={!text.trim() && attachments.length === 0}
          className="p-2 rounded-lg bg-accent text-accent-foreground disabled:opacity-30"
        >
          发送
        </button>
      </div>
    </div>
  );
}

/** 客户端图片压缩 */
async function compressImage(
  file: File,
  maxWidth: number,
  maxHeight: number,
  quality: number
): Promise<{ base64: string; mimeType: string }> {
  const img = document.createElement('img');
  const url = URL.createObjectURL(file);

  await new Promise<void>((resolve) => {
    img.onload = () => resolve();
    img.src = url;
  });

  const canvas = document.createElement('canvas');
  let { width, height } = img;

  if (width > maxWidth || height > maxHeight) {
    const ratio = Math.min(maxWidth / width, maxHeight / height);
    width = Math.floor(width * ratio);
    height = Math.floor(height * ratio);
  }

  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, width, height);

  URL.revokeObjectURL(url);
  const base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
  return { base64, mimeType: 'image/jpeg' };
}
```

### 7.2 MediaBubble

```tsx
// apps/web/src/components/chat/MediaBubble.tsx

import { useState, useRef, useEffect } from 'react';

interface MediaContent {
  type: 'text' | 'image' | 'audio' | 'image-generation';
  text?: string;
  base64?: string;
  mimeType?: string;
  audioUrl?: string;
  /** TTS 字幕同步 */
  wordTimestamps?: Array<{ word: string; start: number; end: number }>;
}

interface MediaBubbleProps {
  content: MediaContent[];
  isStreaming?: boolean;
}

/**
 * MediaBubble —— 支持多模态内容的消息气泡
 *
 * 渲染规则：
 * - text → Markdown 渲染（保持流式打字效果）
 * - image → 缩略图 + 点击放大
 * - audio → 内联音频播放器，字幕同步高亮
 * - image-generation → 图片卡片 + 下载按钮
 */
export function MediaBubble({ content, isStreaming }: MediaBubbleProps) {
  return (
    <div className="space-y-2">
      {content.map((item, idx) => {
        switch (item.type) {
          case 'text':
            return <TextContent key={idx} text={item.text || ''} isStreaming={isStreaming} />;
          case 'image':
            return <ImageContent key={idx} base64={item.base64!} mimeType={item.mimeType || 'image/png'} />;
          case 'audio':
            return (
              <AudioContent
                key={idx}
                audioData={item.base64!}
                mimeType={item.mimeType || 'audio/mp3'}
                wordTimestamps={item.wordTimestamps}
              />
            );
          case 'image-generation':
            return <GeneratedImage key={idx} base64={item.base64!} prompt={item.text || ''} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

/** 文字内容（带流式效果） */
function TextContent({ text, isStreaming }: { text: string; isStreaming?: boolean }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none">
      <p className="whitespace-pre-wrap text-sm">{text}</p>
      {isStreaming && (
        <span className="inline-block w-1.5 h-4 bg-accent animate-pulse" />
      )}
    </div>
  );
}

/** 图片内容——缩略图 + 点击放大 */
function ImageContent({ base64, mimeType }: { base64: string; mimeType: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <img
        src={`data:${mimeType};base64,${base64}`}
        alt="图片"
        className="max-w-xs rounded-lg border border-border cursor-pointer hover:ring-2 hover:ring-accent transition-all"
        onClick={() => setExpanded(true)}
      />
      {/* 全屏放大遮罩 */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          <img
            src={`data:${mimeType};base64,${base64}`}
            alt="图片（放大）"
            className="max-w-[90vw] max-h-[90vh] object-contain"
          />
        </div>
      )}
    </>
  );
}

/** 音频内容——内联播放器 + 字幕同步高亮 */
function AudioContent({ audioData, mimeType, wordTimestamps }: {
  audioData: string;
  mimeType: string;
  wordTimestamps?: Array<{ word: string; start: number; end: number }>;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [currentTime, setCurrentTime] = useState(0);

  const audioUrl = `data:${mimeType};base64,${audioData}`;

  // 高亮当前时间戳对应文字
  const highlightsCurrentWord = (timestamps: Array<{ word: string; start: number; end: number }>) => {
    const current = timestamps.find(t => currentTime >= t.start && currentTime < t.end);
    return timestamps.map((t, idx) => (
      <span
        key={idx}
        className={`transition-colors ${
          currentTime >= t.start && currentTime < t.end
            ? 'bg-accent/30 text-accent'
            : 'opacity-60'
        }`}
      >
        {t.word}
      </span>
    ));
  };

  return (
    <div className="space-y-2">
      <audio
        ref={audioRef}
        src={audioUrl}
        controls
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        className="w-full"
      />
      {wordTimestamps && (
        <p className="text-xs leading-relaxed px-2">
          {highlightsCurrentWord(wordTimestamps)}
        </p>
      )}
    </div>
  );
}

/** 生成图片内容——带下载按钮 */
function GeneratedImage({ base64, prompt }: { base64: string; prompt: string }) {
  const handleDownload = () => {
    const link = document.createElement('a');
    link.href = `data:image/png;base64,${base64}`;
    link.download = `generated-${Date.now()}.png`;
    link.click();
  };

  return (
    <div className="relative group">
      <img
        src={`data:image/png;base64,${base64}`}
        alt={prompt}
        className="max-w-sm rounded-lg border border-border"
      />
      <div className="absolute bottom-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
        <button
          onClick={handleDownload}
          className="px-2 py-1 text-xs rounded bg-black/60 text-white hover:bg-black/80"
        >
          ⬇ 下载
        </button>
      </div>
      <p className="text-[10px] opacity-40 mt-1">🎨 {prompt.slice(0, 60)}...</p>
    </div>
  );
}
```

> 🤖 **AI 常见错误**：音频消息还没播完就发下一条。如果 Agent 的回复还没播放完毕，用户就发送了新消息（或 Agent 自己的下一条回复触发了新的 TTS），需要：1) 立即停止当前播放；2) 清空播放队列；3) 开始新的。这需要在 TTSManger 的 `stop()` 被调用时彻底释放 AudioContext 资源。

---

## 8. AI 避坑

### 8.1 多模态 token 消耗暴增

**问题**：一张 4K 照片直接发给视觉 LLM ≈ 2000+ token（仅图片部分），费用是同样长度文字的 20 倍。如果用户在对话中发了 3 张图 + 问题，token 账单直接起飞。

**解决**：
1. 前端发送前压缩到 512x512（视觉 LLM 的最低有效分辨率）或 1024x1024（图表分析场景）。
2. 设置 token 预算上限：单次对话的多模态 token 不能超过总预算的 30%。
3. 对于非必要的图片（如用户随手发的表情包），降低分辨率到 256x256 或使用 fast 模式。

### 8.2 TTS 延迟影响对话节奏

**问题**：TTS 需要整段文字完成才能开始合成。如果 Agent 回复了 5 句话，用户在等第一句话的 TTS 就要等全部文字生成完——导致"AI 不说话"的感觉。

**解决**：
1. **Sentence 级流式**：在句子边界（`.!?。！？`）切分，每句单独合成播放。这样第一句 200ms 内就开始播放。
2. **预合成**：Agent 正在生成文字时，看到第一个完整句子就开始 TTS 合成（不等全部到齐）。
3. **播放指示器**：还在合成时显示一个"正在生成语音..."的微动效，让用户知道系统在忙。

### 8.3 屏幕截图隐私泄露

**问题**：`getDisplayMedia` 会捕获用户整个桌面或某个窗口。如果用户选择在公开场合截图，可能包含敏感信息（邮件、密码管理器内容）。Agent 把截图发送给云端 LLM，等于把隐私数据发给了 API provider。

**解决**：
1. 明确提示"Agent 将看到你选择的屏幕内容"。
2. 提供"敏感区域模糊"功能（客户端在发送前对指定区域做模糊处理）。
3. 本地 LLM 方案（如 Ollama + LLaVA）支持完全离线处理。
4. 添加水印标识"Generated by Agent"便于审计。

### 8.4 音频消息还没播完就发下一条

**问题**：前一条消息的 TTS 还在播放，新消息就触发了新的 TTS。两个音频流交织播放，用户体验极差。

**解决**：TTSManger 必须维护一个**播放互斥锁**：
```typescript
async speakStream(textStream: AsyncGenerator<string>): Promise<void> {
  if (this.isPlaying) this.stop();  // 立即停止当前播放
  this.isPlaying = true;
  // ... 新播放
}
```

---

## 与 SKILL.md 执行顺序的衔接

| 前置依赖 | 本文件独立解决的问题 |
|---------|---------------------|
| 01-foundation.md 的 Agent Core 和 LLM 抽象 | Modality Router 在多模态场景下的模型选择 |
| 02-tools-skills.md 的工具系统 | 图片生成作为 Agent 可调用的 Tool |
| 03-memory-rag.md 的多格式解析器 | 图片预处理管线独立于知识库，服务于 Agent 对话 |
| 01-foundation.md 的 SSE 协议 | 多模态内容的 SSE 消息类型（type: image/audio） |

> 🤖 **工程逻辑**：多模态是"锦上添花"的能力层——Agent 去掉多模态仍然是完整的文本 Agent，但加上多模态才能覆盖更多使用场景。建议在完成 01-07 基础层后，根据用户需求选择性实现本文件的子模块（只做图片理解？还是全套？）。

# 15 — 知识库管理 · RAG 全生命周期

> 本 reference 覆盖知识库的完整生命周期管理——不只是"丢进向量数据库就行"。从多格式文档上传、Parser Registry 自动分发、Delta Indexing、召回质量评估、版本化到前端知识库管理 Portal，提供独立落地的全部后端 + 前端代码。本文件是 03-memory-rag.md 中 RAG 部分的深度扩展。

---

## 目录

- [工程逻辑：知识库完整生命周期](#工程逻辑知识库完整生命周期)
- [1. 多格式解析器](#1-多格式解析器)
- [2. Parser Registry 模式](#2-parser-registry-模式)
- [3. Delta Indexing](#3-delta-indexing)
- [4. 召回质量自动评估](#4-召回质量自动评估)
- [5. 版本化](#5-版本化)
- [6. 源引用](#6-源引用)
- [7. 前端：知识库管理 Portal](#7-前端知识库管理-portal)
- [8. AI 避坑](#8-ai-避坑)

---

## 工程逻辑：知识库完整生命周期

RAG 不是"用户上传文档 → 切块 → 召回"这么简单。生产级知识库有完整的生命周期，每个环节都影响最终召回质量：

```
┌──────────────────────────────────────────────────────────────────────┐
│                    知识库完整生命周期                                   │
│                                                                        │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐          │
│  │  上传     │──▶│  解析     │──▶│  分块     │──▶│  索引     │          │
│  │ (Upload) │   │ (Parse)  │   │ (Split)  │   │ (Index)  │          │
│  └──────────┘   └──────────┘   └──────────┘   └──────────┘          │
│       │                                              │                 │
│       │           ┌──────────┐                       │                 │
│       │           │  归档     │◀──────────────────────┘                 │
│       │           │(Archive) │                                         │
│       │           └──────────┘                                         │
│       │              ▲                                                 │
│       ▼              │                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                          │
│  │  查询     │──▶│  反馈     │──▶│  更新     │                          │
│  │ (Query)  │   │(Feedback)│   │(Update)  │                          │
│  └──────────┘   └──────────┘   └──────────┘                          │
│       │                                                                  │
│       ▼                                                                  │
│  ┌──────────┐                                                           │
│  │版本化/回滚│                                                           │
│  │(Version) │                                                           │
│  └──────────┘                                                           │
└──────────────────────────────────────────────────────────────────────┘
```

**关键设计原则**：
1. **解析与分离**：解析器按 MIME type 自动分发，新增格式只需注册新解析器，不改现有代码。
2. **增量更新**：文档编辑后只重新索引变化的部分（Delta Indexing），不重建整个 collection。
3. **可追溯**：每个 chunk 都记录来源文档、页码/段落位置，支持"这个信息来自第3页第2段"式的源引用。
4. **质量闭环**：召回结果收集用户反馈，bad case 自动积累用于后续 prompt 调优。

---

## 1. 多格式解析器

不同格式需要不同的解析策略。以下是每种格式的推荐库选型与解析逻辑：

| 格式 | 推荐库 | 关键策略 |
|------|--------|---------|
| PDF | `pdf-parse` / `pdfjs-dist` | 提取文本 + 保留页码信息；表格用 `pdf2table` 或专用 OCR |
| DOCX | `mammoth` / `docx` | 转 Markdown 保留层级结构；提取标题层级用于语义分块 |
| HTML | `cheerio` / `turndown` | 转 Markdown 去掉标签；保留 `<img alt>` 文本用于 embedding |
| MD | 直接读取 | 按标题层级 (`#`/`##`) 语义分块，比字符切块效果更好 |
| PPTX | `pptx2json` / `python-pptx` (子进程) | 逐页提取文本；将每页作为独立 chunk |
| CSV | `papaparse` / `d3-dsv` | 按行或按批处理；生成结构化描述用于检索 |
| JSON | 直接 parse | 按字段路径分 chunk，保留字段名作为上下文 |

```typescript
// packages/core/src/knowledge/parsers/types.ts

export interface ParsedDocument {
  id: string;
  title: string;
  content: string;                    // 完整文本内容
  sections: DocumentSection[];        // 结构化段落（用于源引用）
  metadata: {
    source: string;                   // 文件路径或 URL
    mimeType: string;
    parseTimestamp: number;
    pageCount?: number;
    wordCount: number;
    [key: string]: unknown;
  };
}

export interface DocumentSection {
  id: string;
  title?: string;                     // 标题（如 markdown 的 ## 标题）
  content: string;                    // 段落文本
  pageNumber?: number;                // 页码（PDF/PPTX）
  position: { start: number; end: number }; // 在原文中的字符偏移
  headingLevel?: number;              // 标题层级（1=H1, 2=H2...）
}

export interface DocumentParser {
  parse(buffer: Buffer, fileName: string, mimeType: string): Promise<ParsedDocument>;
  supports(mimeType: string): boolean;
  readonly priority: number;          // 多解析器匹配时选 priority 最高的
}
```

**PDF 解析器**——最常出问题的格式：

```typescript
// packages/core/src/knowledge/parsers/pdfParser.ts

import type { ParsedDocument, DocumentSection, DocumentParser } from './types';
import { v4 as uuid } from 'uuid';

/**
 * PDF 解析器
 *
 * 工程选型：
 * - pdf-parse（Node.js 友好，纯 JS 实现）适合简单 PDF
 * - 扫描版 PDF（图片型）需要 OCR：tesseract.js 或云服务
 * - 表格型 PDF 需要专用库（pdf2table / tabula-java 子进程）
 *
 * 设计决策：保留页码信息用于源引用。每个 chunk 的 pageNumber
 * 存储在 metadata 中，RAG 召回后可通过 pageNumber 定位原文。
 */
export class PDFParser implements DocumentParser {
  readonly priority = 100;
  private pdfParse: any;

  /**
   * 懒加载 pdf-parse：这个包很大，只在需要 PDF 解析时才加载
   */
  private async getParser() {
    if (!this.pdfParse) {
      this.pdfParse = (await import('pdf-parse')).default;
    }
    return this.pdfParse;
  }

  async parse(buffer: Buffer, fileName: string, _mimeType: string): Promise<ParsedDocument> {
    const pdfParse = await this.getParser();
    const data = await pdfParse(buffer, {
      // 页码追踪回调——每次开始新页时触发
      pagerender: (pageData: any) => {
        // 保留每页的文本内容，后续用于生成带页码的 sections
        return pageData.getTextContent({
          normalizeWhitespace: true,
          disableCombineTextItems: false,
        }).then((textContent: any) => {
          const pageText = textContent.items
            .map((item: any) => item.str)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          return pageText;
        });
      },
    });

    // 构建 sections：按页码分段
    const sections: DocumentSection[] = [];
    const pages = data.text.split(/\f/); // 分页符

    pages.forEach((pageText, pageIdx) => {
      const trimmed = pageText.trim();
      if (trimmed.length > 0) {
        sections.push({
          id: `pdf-${uuid()}-${pageIdx}`,
          content: trimmed,
          pageNumber: pageIdx + 1,
          position: { start: 0, end: trimmed.length },
        });
      }
    });

    return {
      id: `doc-${uuid()}`,
      title: fileName.replace(/\.pdf$/i, ''),
      content: data.text,
      sections,
      metadata: {
        source: fileName,
        mimeType: 'application/pdf',
        parseTimestamp: Date.now(),
        pageCount: data.numpages,
        wordCount: data.text.split(/\s+/).length,
      },
    };
  }

  supports(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  }
}
```

**DOCX 解析器**——利用 mammoth 保留标题层级：

```typescript
// packages/core/src/knowledge/parsers/docxParser.ts

import type { ParsedDocument, DocumentSection, DocumentParser } from './types';
import { v4 as uuid } from 'uuid';

/**
 * DOCX 解析器
 *
 * 工程选型：
 * - mammoth：将 DOCX 转为 Markdown，保留标题层级（h1-h6 → markdown #）
 * - 比直接提取纯文本好，因为保留的结构信息可以做"按标题分块"
 * - 不支持表格的完全还原，但文字内容完全够用
 */
export class DOCXParser implements DocumentParser {
  readonly priority = 100;

  async parse(buffer: Buffer, fileName: string, _mimeType: string): Promise<ParsedDocument> {
    const mammoth = await import('mammoth');
    const result = await mammoth.convertToHtml({ buffer });

    // 用 cheerio 从 HTML 中提取结构
    const cheerio = await import('cheerio');
    const $ = cheerio.load(result.value);

    const sections: DocumentSection[] = [];
    let currentOffset = 0;

    // 按标题分段：每个 h1-h6 开始一个新 section
    $('h1, h2, h3, h4, h5, h6, p').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const isHeading = /^h[1-6]$/.test(tag);
      const text = $(el).text().trim();

      if (text.length > 0) {
        sections.push({
          id: `docx-${uuid()}-${sections.length}`,
          title: isHeading ? text : undefined,
          content: text,
          headingLevel: isHeading ? parseInt(tag[1]) : undefined,
          position: { start: currentOffset, end: currentOffset + text.length },
        });
        currentOffset += text.length + 1;
      }
    });

    return {
      id: `doc-${uuid()}`,
      title: fileName.replace(/\.docx$/i, ''),
      content: $.text(),
      sections,
      metadata: {
        source: fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        parseTimestamp: Date.now(),
        wordCount: $.text().split(/\s+/).length,
      },
    };
  }

  supports(mimeType: string): boolean {
    return mimeType.includes('wordprocessingml') ||
           mimeType === 'application/msword';
  }
}
```

**HTML 解析器**——保留 alt text、转 Markdown：

```typescript
// packages/core/src/knowledge/parsers/htmlParser.ts

import type { ParsedDocument, DocumentSection, DocumentParser } from './types';
import { v4 as uuid } from 'uuid';

/**
 * HTML 解析器
 *
 * 工程选型：
 * - cheerio 解析 DOM，提取结构
 * - 关键：保留 <img alt="..."> 的 alt 文本——图片信息不能丢
 * - 关键：保留 <title> 作为文档标题
 * - turndown 用于转纯 Markdown（可选）
 *
 * AI 常见错误：直接在 HTML 上做 regex 提取。
 * HTML 嵌套、转义、CDATA、script/style 标签会让你得到一坨噪音。
 * 正确做法：用 cheerio（服务端 jQuery）解析 DOM tree。
 */
export class HTMLParser implements DocumentParser {
  readonly priority = 80;

  async parse(buffer: Buffer, fileName: string, _mimeType: string): Promise<ParsedDocument> {
    const cheerio = await import('cheerio');
    const html = buffer.toString('utf-8');
    const $ = cheerio.load(html);

    // 移除脚本和样式
    $('script, style, noscript').remove();

    // 提取标题
    const title = $('title').text().trim() || $('h1').first().text().trim() || fileName;

    // 关键：保留图片 alt 文本
    $('img').each((_, el) => {
      const alt = $(el).attr('alt');
      if (alt) {
        $(el).replaceWith(` [Image: ${alt}] `);
      } else {
        $(el).remove();
      }
    });

    // 提取 sections：按标题分段
    const sections: DocumentSection[] = [];
    let currentOffset = 0;

    $('h1, h2, h3, h4, h5, h6, p, li').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const isHeading = /^h[1-6]$/.test(tag);
      const text = $(el).text().trim();

      if (text.length > 0) {
        sections.push({
          id: `html-${uuid()}-${sections.length}`,
          title: isHeading ? text : undefined,
          content: text,
          headingLevel: isHeading ? parseInt(tag[1]) : undefined,
          position: { start: currentOffset, end: currentOffset + text.length },
        });
        currentOffset += text.length + 1;
      }
    });

    return {
      id: `doc-${uuid()}`,
      title,
      content: $.text().replace(/\s+/g, ' ').trim(),
      sections,
      metadata: {
        source: fileName,
        mimeType: 'text/html',
        parseTimestamp: Date.now(),
        wordCount: $.text().split(/\s+/).length,
      },
    };
  }

  supports(mimeType: string): boolean {
    return mimeType === 'text/html' || mimeType.includes('html');
  }
}
```

> 🤖 **AI 常见错误**：
> 1. **PDF 提取到乱码** —— 扫描版 PDF 本质是图片串，`pdf-parse` 提取出来的是空白或乱码。必须先做 OCR（tesseract）或用云 OCR 服务。
> 2. **图片 alt text 没纳入 embedding** —— HTML/DOCX 中的图片携带大量语义信息。如果不保留 alt text，embedding 模型完全不知道图片内容。

---

## 2. Parser Registry 模式

**工程逻辑**：新文档格式层出不穷，不应该每次加新格式都改核心管线代码。Parser Registry 是策略模式的实践——注册一次，按 MIME type 自动分发。

```typescript
// packages/core/src/knowledge/registry.ts

import type { DocumentParser, ParsedDocument } from './parsers/types';

/**
 * Parser Registry —— 按 MIME type 自动分发解析器
 *
 * 设计选择：
 * - 支持多个解析器注册同一 MIME type，按 priority 选最高的
 * - 提供 fallback 到纯文本解析器（TextFallbackParser）
 * - lazy import：各解析器按需加载，不启动时全部 import
 */
export class ParserRegistry {
  private parsers: DocumentParser[] = [];
  private textFallback: DocumentParser;

  constructor(textFallback: DocumentParser) {
    this.textFallback = textFallback;
  }

  /** 注册解析器 */
  register(parser: DocumentParser): void {
    this.parsers.push(parser);
    // 按 priority 降序排，getParser 取第一个匹配即可
    this.parsers.sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取能处理此 MIME type 的解析器
   * 优先级：已注册解析器 > textFallback
   */
  getParser(mimeType: string): DocumentParser {
    for (const parser of this.parsers) {
      if (parser.supports(mimeType)) {
        return parser;
      }
    }
    return this.textFallback;
  }

  /** 解析文档（一站式入口） */
  async parse(buffer: Buffer, fileName: string, mimeType: string): Promise<ParsedDocument> {
    const parser = this.getParser(mimeType);
    return parser.parse(buffer, fileName, mimeType);
  }

  /** 列出所有已注册的 MIME type（前端展示用） */
  listSupportedTypes(): string[] {
    // 从各解析器的 supports 方法反推出 MIME type 列表
    const commonTypes = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/html',
      'text/markdown',
      'text/plain',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/csv',
      'application/json',
    ];
    return commonTypes.filter(t => this.getParser(t) !== this.textFallback);
  }
}

/** 纯文本兜底解析器 */
export class TextFallbackParser implements DocumentParser {
  readonly priority = 0;

  async parse(buffer: Buffer, fileName: string, mimeType: string): Promise<ParsedDocument> {
    const content = buffer.toString('utf-8');
    return {
      id: `doc-fallback-${Date.now()}`,
      title: fileName,
      content,
      sections: [{
        id: `section-0`,
        content,
        position: { start: 0, end: content.length },
      }],
      metadata: {
        source: fileName,
        mimeType,
        parseTimestamp: Date.now(),
        wordCount: content.split(/\s+/).length,
      },
    };
  }

  supports(_mimeType: string): boolean {
    return true; // 兜底：什么格式都支持
  }
}

/** 全局单例 */
let _registry: ParserRegistry | null = null;

export function getParserRegistry(): ParserRegistry {
  if (!_registry) {
    _registry = new ParserRegistry(new TextFallbackParser());
    // 注册所有内置解析器
    // 注意：实际 import 放在此处，利用 lazy import 机制
    // _registry.register(new PDFParser());
    // _registry.register(new DOCXParser());
    // _registry.register(new HTMLParser());
  }
  return _registry;
}
```

---

## 3. Delta Indexing

**工程逻辑**：文档修改了，不需要重新上传、重新解析、重新分块、重新 embedding 全部分块。只需要计算 diff，对变化的部分重新索引。这节省了 90%+ 的 embedding API 调用。

```typescript
// packages/core/src/knowledge/delta.ts

import type { ParsedDocument, DocumentSection } from './parsers/types';

export interface DeltaResult {
  addedSections: DocumentSection[];       // 新增的段落
  modifiedSections: DocumentSection[];    // 内容变化的段落
  removedSectionIds: string[];            // 删除的段落 ID
  unchangedCount: number;                 // 未变化的段落数
}

/**
 * Delta Indexing —— 文档变化检测
 *
 * 算法选择：
 * 1. 基于 section ID 匹配（同一 section 跨版本）
 * 2. MD5 hash 检测内容变化
 * 3. 输出 added/modified/removed 三类变更
 *
 * 工程决策：section ID 应基于内容+位置生成（如 heading + position 的 hash），
 * 这样文档编辑后 section 仍能被匹配（位置的局部调整可容忍）
 */
export function computeSectionDelta(
  oldDoc: ParsedDocument,
  newDoc: ParsedDocument
): DeltaResult {
  const oldMap = new Map(oldDoc.sections.map(s => [s.id, s]));
  const newMap = new Map(newDoc.sections.map(s => [s.id, s]));

  const addedSections: DocumentSection[] = [];
  const modifiedSections: DocumentSection[] = [];
  const removedSectionIds: string[] = [];
  let unchangedCount = 0;

  // 检测新增和修改
  for (const [id, newSection] of newMap) {
    const oldSection = oldMap.get(id);
    if (!oldSection) {
      addedSections.push(newSection);
    } else if (hashSection(oldSection) !== hashSection(newSection)) {
      modifiedSections.push(newSection);
    } else {
      unchangedCount++;
    }
  }

  // 检测删除
  for (const [id] of oldMap) {
    if (!newMap.has(id)) {
      removedSectionIds.push(id);
    }
  }

  return { addedSections, modifiedSections, removedSectionIds, unchangedCount };
}

/**
 * Section 内容 hash —— 用于检测内容是否变化
 * 简单实现用 MD5/LCYCLE hash，生产可用 xxhash 替代
 */
function hashSection(section: DocumentSection): string {
  const normalized = section.content.trim().replace(/\s+/g, ' ');
  // 简单 hash：实际项目用 crypto.createHash 或 fast-hash
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) - hash + normalized.charCodeAt(i)) | 0;
  }
  return `${section.id}-${hash}`;
}

/**
 * Delta Indexing 编排器
 *
 * 核心流程：
 * 1. 加载文档旧版本
 * 2. 解析新版本
 * 3. 计算 diff
 * 4. 对 added/modified sections 做 embedding + 入库
 * 5. 对 removed sections 做 vectorStore.delete
 * 6. 旧 unchanged 部分完全不动
 */
export class DeltaIndexer {
  constructor(
    private retriever: { indexChunks(chunks: any[]): Promise<void>; removeDocument(docId: string): Promise<void>; },
    private embedding: { embedBatch(texts: string[]): Promise<number[][]>; },
    private oldDocProvider: (docId: string) => Promise<ParsedDocument | null>,
  ) {}

  async index(docId: string, newDoc: ParsedDocument, splitter: { split(text: string, docId: string): any[] }): Promise<{
    indexed: number;
    removed: number;
    unchanged: number;
  }> {
    const oldDoc = await this.oldDocProvider(docId);

    if (!oldDoc) {
      // 首次索引：全量
      const chunks = splitter.split(newDoc.content, docId);
      await this.retriever.indexChunks(chunks);
      return { indexed: chunks.length, removed: 0, unchanged: 0 };
    }

    // 增量索引
    const delta = computeSectionDelta(oldDoc, newDoc);

    // 1. 删除已移除的 chunks
    if (delta.removedSectionIds.length > 0) {
      // 按 sectionId 对应的 chunk 范围批量删除
      for (const sectionId of delta.removedSectionIds) {
        await this.retriever.removeDocument(sectionId);
      }
    }

    // 2. 对新增和修改的 sections 重新 embedding
    const sectionsToIndex = [...delta.addedSections, ...delta.modifiedSections];
    if (sectionsToIndex.length > 0) {
      const chunks = splitter.split(
        sectionsToIndex.map(s => s.content).join('\n\n'),
        docId
      );
      await this.retriever.indexChunks(chunks);
    }

    return {
      indexed: sectionsToIndex.length,
      removed: delta.removedSectionIds.length,
      unchanged: delta.unchangedCount,
    };
  }
}
```

> 🤖 **工程逻辑**：Delta Indexing 的核心价值在"文档频繁编辑"场景下才体现。如果用户上传文档后从不编辑，全量索引就够了。但如果用户每天都在编辑内部 Wiki（如 Confluence），Delta Indexing 节省的 embedding API 成本非常可观。

---

## 4. 召回质量自动评估

**工程逻辑**：RAG 召回质量不是"能返回结果"就算好返回。需要持续追踪 recall score，收集 bad case，形成质量监控闭环。

```typescript
// packages/core/src/knowledge/feedback.ts

import type { RAGResult } from '../rag/retriever';

export type FeedbackType = 'relevant' | 'irrelevant' | 'partial';

export interface RetrievalFeedback {
  id: string;
  docId: string;
  query: string;
  chunkId: string;
  feedback: FeedbackType;
  retrievalScore: number;       // 召回时的 similarity 分数
  rank: number;                 // 召回结果中的排名
  timestamp: number;
  userId: string;
  comment?: string;             // 用户可选填写的文字反馈
}

/**
 * 召回质量评估器
 *
 * 指标追踪：
 * 1. Precision@K —— 前 K 个结果中 relevant 的比例
 * 2. Bad Case Rate —— feedback = irrelevant / 总召回次数
 * 3. Retrieval Score Distribution —— similarity 分数分布（检测退化）
 * 4. Zero-Result Rate —— 查询没有返回任何结果的比率（知识库空指示）
 */
export class RetrievalQualityTracker {
  private feedbackLog: RetrievalFeedback[] = [];
  private scoreHistory: Array<{ score: number; timestamp: number }> = [];

  /** 记录一次检索反馈 */
  recordRetrieval(ragResults: RAGResult[], query: string, userId: string): string {
    const retrievalId = `retrieval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 记录分数分布
    for (const result of ragResults) {
      this.scoreHistory.push({
        score: result.similarity,
        timestamp: Date.now(),
      });
    }

    return retrievalId; // 前端用此 ID 后续提交反馈
  }

  /** 提交用户反馈 */
  submitFeedback(feedback: RetrievalFeedback): void {
    this.feedbackLog.push(feedback);
  }

  /**
   * 计算当前平均 Precision@K
   * 默认 K=5 表示"在前 5 个结果中"
   */
  getPrecisionAtK(k: number = 5): number {
    const relevantCount = this.feedbackLog.filter(
      f => f.rank <= k && f.feedback === 'relevant'
    ).length;
    const totalCount = this.feedbackLog.filter(f => f.rank <= k).length;
    return totalCount > 0 ? relevantCount / totalCount : 0;
  }

  /**
   * Bad Case 列表 —— 召回但用户标记不相关的 case
   * 这些 case 可用于后续 prompt 调优、query 改写策略改进
   */
  getBadCases(limit: number = 20): RetrievalFeedback[] {
    return this.feedbackLog
      .filter(f => f.feedback === 'irrelevant')
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, limit);
  }

  /**
   * 知识库健康报告 —— 定期生成的质量概览
   */
  getHealthReport(): {
    totalQueries: number;
    averageScore: number;
    zeroResultRate: number;
    precisionAt5: number;
    badCaseCount: number;
  } {
    const recentScores = this.scoreHistory.slice(-1000);
    const avgScore = recentScores.length > 0
      ? recentScores.reduce((sum, s) => sum + s.score, 0) / recentScores.length
      : 0;

    return {
      totalQueries: new Set(this.feedbackLog.map(f => f.chunkId)).size,
      averageScore: avgScore,
      zeroResultRate: 0, // 需要配合 zero-result 追踪逻辑
      precisionAt5: this.getPrecisionAtK(5),
      badCaseCount: this.getBadCases(Infinity).length,
    };
  }
}
```

> 🤖 **工程逻辑**：Bad Case 自动收集的价值在于——当 bad case 积累到一定量（如 20 个），可以用 LLM 分析这些 case 的共性，自动发现"哪类查询容易召回错误"或"哪些 chunk 质量有问题"。这是知识库质量持续改进的基础设施。

---

## 5. 版本化

**工程逻辑**：知识库文档应具备版本管理能力——可以追溯到某个历史版本、比较差异、回滚。这在企业场景中必不可少（合规审计、错误回退）。

```typescript
// packages/core/src/knowledge/version.ts

export interface DocumentVersion {
  docId: string;
  versionId: string;
  versionNumber: number;             // 递增的版本号
  contentHash: string;               // 内容 hash，用于判断是否有实质变化
  wordCount: number;
  chunkCount: number;
  sectionsSnapshot: { id: string; content: string; title?: string }[]; // 轻量快照
  createdAt: number;
  changeDescription?: string;        // 变更说明
  createdBy: string;                 // 用户 ID
}

/**
 * 版本管理器
 *
 * 工程选择：
 * 1. 不保存完整的原始文件内容（太重），只保存 sections hash 快照
 * 2. 内容本身仍存储在 vector store 中——回滚时只需重新 embedding
 * 3. 版本快照存储在结构化数据库（SQLite / PostgreSQL），不用向量库
 */
export class DocumentVersionManager {
  private versions = new Map<string, DocumentVersion[]>();

  /** 创建新版本 */
  createVersion(docId: string, snapshot: Omit<DocumentVersion, 'versionId' | 'versionNumber' | 'createdAt'>): DocumentVersion {
    const docVersions = this.versions.get(docId) || [];

    const newVersion: DocumentVersion = {
      ...snapshot,
      versionId: `v-${docVersions.length + 1}-${Date.now()}`,
      versionNumber: docVersions.length + 1,
      createdAt: Date.now(),
    };

    docVersions.push(newVersion);
    this.versions.set(docId, docVersions);
    return newVersion;
  }

  /** 获取某文档的所有版本（倒序，最新在前） */
  getVersions(docId: string): DocumentVersion[] {
    return [...(this.versions.get(docId) || [])].reverse();
  }

  /** 获取特定版本 */
  getVersion(docId: string, versionId: string): DocumentVersion | null {
    return this.versions.get(docId)?.find(v => v.versionId === versionId) ?? null;
  }

  /** 比较两个版本的差异 */
  compareVersions(docId: string, versionA: string, versionB: string): {
    addedSections: number;
    removedSections: number;
    changedSections: number;
    wordCountDelta: number;
  } {
    const vA = this.getVersion(docId, versionA);
    const vB = this.getVersion(docId, versionB);
    if (!vA || !vB) return { addedSections: 0, removedSections: 0, changedSections: 0, wordCountDelta: 0 };

    const setA = new Set(vA.sectionsSnapshot.map(s => s.id));
    const setB = new Set(vB.sectionsSnapshot.map(s => s.id));

    const added = [...setB].filter(id => !setA.has(id)).length;
    const removed = [...setA].filter(id => !setB.has(id)).length;

    // 变化检测：比较同 ID 的 sections 内容 hash
    let changed = 0;
    const mapB = new Map(vB.sectionsSnapshot.map(s => [s.id, s]));
    for (const secA of vA.sectionsSnapshot) {
      const secB = mapB.get(secA.id);
      if (secB && secA.content !== secB.content) changed++;
    }

    return {
      addedSections: added,
      removedSections: removed,
      changedSections: changed,
      wordCountDelta: vB.wordCount - vA.wordCount,
    };
  }

  /** 回滚到指定版本 */
  rollback(docId: string, versionId: string): DocumentVersion | null {
    const version = this.getVersion(docId, versionId);
    if (!version) return null;

    // 创建新版本（回滚操作本身产生新版本，不覆盖历史）
    return this.createVersion(docId, {
      docId,
      contentHash: version.contentHash,
      wordCount: version.wordCount,
      chunkCount: version.chunkCount,
      sectionsSnapshot: version.sectionsSnapshot,
      changeDescription: `Rollback to version ${version.versionNumber}`,
      createdBy: 'system',
    });
  }

  /**
   * 清理旧版本——保留最近 N 个版本，或清理超过 N 天的版本
   * 防止版本无限增长导致存储膨胀
   */
  pruneVersions(docId: string, options?: { keepCount?: number; maxAgeDays?: number }): number {
    const versions = this.versions.get(docId);
    if (!versions) return 0;

    let prunedCount = 0;

    // 保留最近 N 个版本
    if (options?.keepCount && versions.length > options.keepCount) {
      prunedCount = versions.length - options.keepCount;
      this.versions.set(docId, versions.slice(-options.keepCount));
    }

    // 清理超过 maxAgeDays 的版本（保留至少 1 个）
    if (options?.maxAgeDays && versions.length > 1) {
      const cutoff = Date.now() - options.maxAgeDays * 24 * 60 * 60 * 1000;
      const filtered = versions.filter((v, idx) => idx === 0 || v.createdAt >= cutoff);
      prunedCount += versions.length - filtered.length;
      this.versions.set(docId, filtered);
    }

    return prunedCount;
  }
}
```

---

## 6. 源引用

**工程逻辑**：RAG 召回的信息必须能追溯到原始文档位置——不只是"返回一段文本"，还要告诉用户"这段话来自 XX 文档的第 3 页第 2 段"。这是企业级 RAG 的硬需求（合规、可信度、后续编辑追踪）。

```typescript
// packages/core/src/knowledge/citation.ts

export interface SourceCitation {
  docId: string;
  docTitle: string;
  pageNumber?: number;            // 页码（PDF/PPTX）
  sectionTitle?: string;          // 章节标题
  position: { start: number; end: number }; // 字符偏移
  chunkIndex: number;             // chunk 在文档中的索引
}

/**
 * 源引用生成器
 *
 * 将 RAGResult 转换为可读的引用格式
 * 例："来自《产品需求文档 v2.3》第 3 页「用户认证流程」:142-287"
 */
export function formatCitation(citation: SourceCitation): string {
  const parts: string[] = [];

  if (citation.docTitle) {
    parts.push(`《${citation.docTitle}》`);
  }

  if (citation.pageNumber) {
    parts.push(`第${citation.pageNumber}页`);
  }

  if (citation.sectionTitle) {
    parts.push(`「${citation.sectionTitle}」`);
  }

  return `来源: ${parts.join(' ')}`;
}

/**
 * 引用管理器 —— 管理 chunk 到原文的映射
 *
 * 存储策略：引用元数据存在 vectorStore 的 payload 中
 * 这样检索结果自带 citation 信息，只需 format 输出
 */
export class CitationManager {
  /**
   * 根据召回结果生成带有引用的上下文
   * 输出格式可直接注入 system prompt
   */
  static buildCitedContext(
    results: Array<{ content: string; citation: SourceCitation; similarity: number }>
  ): string {
    return results.map((r, idx) => {
      const citationText = formatCitation(r.citation);
      return `[参考 ${idx + 1}] ${r.content}\n   ${citationText}`;
    }).join('\n\n');
  }

  /**
   * 前端用：高亮显示引用来源
   * 返回引用信息数组，前端通过 docId+pageNumber 定位原文
   */
  static extractCitations(results: Array<{ chunk: { metadata: Record<string, unknown> } }>): SourceCitation[] {
    return results.map(r => ({
      docId: r.chunk.metadata.docId as string,
      docTitle: r.chunk.metadata.docTitle as string || 'Unknown',
      pageNumber: r.chunk.metadata.pageNumber as number | undefined,
      sectionTitle: r.chunk.metadata.sectionTitle as string | undefined,
      position: {
        start: r.chunk.metadata.startOffset as number || 0,
        end: r.chunk.metadata.endOffset as number || 0,
      },
      chunkIndex: r.chunk.metadata.chunkIndex as number || 0,
    }));
  }
}
```

---

## 7. 前端：知识库管理 Portal

**工程逻辑**：知识库管理不是"上传按钮 + 删除按钮"那么简单。用户需要看到文档结构、预览内容、测试召回效果、管理版本。Portal 需要四个协同面板。

```
┌─────────────────────────────────────────────────────────────────────┐
│                    知识库管理 Portal                                   │
├──────────┬──────────────────────────────┬───────────────────────────┤
│          │                              │                           │
│  文档树  │       内容预览面板            │     召回测试面板            │
│          │                              │                           │
│ 📁 docs  │  ┌──────────────────────┐   │  ┌──────────────────────┐ │
│ ├─ 📄 a  │  │ 文档标题 + 元数据      │   │  │ 输入查询...          │ │
│ ├─ 📄 b  │  │                      │   │  │                      │ │
│ └─ 📁 sub│  │ [内容带高亮显示]      │   │  │ 召回结果 + 分数      │ │
│   └─ 📄c │  │                      │   │  │ ✅ 相关 ❌ 不相关     │ │
│          │  └──────────────────────┘   │  └──────────────────────┘ │
│          │                              │                           │
├──────────┴──────────────────────────────┴───────────────────────────┤
│                         版本面板                                      │
│  v3 (当前) ← v2 ← v1       [对比差异] [回滚]                        │
└─────────────────────────────────────────────────────────────────────┘
```

```typescript
// apps/web/src/components/knowledge/KnowledgePortal.tsx

import { useState, useCallback } from 'react';
import { DocumentTree } from './DocumentTree';
import { ContentPreview } from './ContentPreview';
import { RetrievalTestPanel } from './RetrievalTestPanel';
import { VersionPanel } from './VersionPanel';
import type { ParsedDocument } from '@agent-core/knowledge/types';

export function KnowledgePortal() {
  const [selectedDoc, setSelectedDoc] = useState<ParsedDocument | null>(null);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<ParsedDocument[]>([]);

  const handleDocSelect = useCallback((docId: string) => {
    setSelectedDocId(docId);
    const doc = documents.find(d => d.id === docId);
    setSelectedDoc(doc || null);
  }, [documents]);

  const handleUpload = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    for (const file of Array.from(files)) {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/knowledge/documents', {
        method: 'POST',
        body: formData,
      });
      const newDoc = await res.json();
      setDocuments(prev => [...prev, newDoc]);
    }
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* 主体四面板 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：文档树 */}
        <div className="w-64 border-r border-border overflow-y-auto p-3">
          <div className="mb-3">
            <label className="block w-full py-2 text-center text-sm rounded-lg border border-dashed border-border cursor-pointer hover:border-accent transition-colors">
              + 上传文档
              <input
                type="file"
                multiple
                className="hidden"
                accept=".pdf,.docx,.html,.md,.pptx,.csv,.json,.txt"
                onChange={e => handleUpload(e.target.files)}
              />
            </label>
          </div>
          <DocumentTree
            documents={documents}
            selectedId={selectedDocId}
            onSelect={handleDocSelect}
          />
        </div>

        {/* 中间：内容预览 */}
        <div className="flex-1 overflow-y-auto p-4 border-r border-border">
          <ContentPreview document={selectedDoc} />
        </div>

        {/* 右侧：召回测试 */}
        <div className="w-96 overflow-y-auto p-4">
          <RetrievalTestPanel docId={selectedDocId} />
        </div>
      </div>

      {/* 底部：版本面板 */}
      <div className="h-48 border-t border-border overflow-y-auto p-4">
        <VersionPanel docId={selectedDocId} />
      </div>
    </div>
  );
}

/** 文档树组件 —— 支持文件夹层级 */
function DocumentTree({ documents, selectedId, onSelect }: {
  documents: ParsedDocument[];
  selectedId: string | null;
  onSelect: (docId: string) => void;
}) {
  // 按文件夹分组
  const groups = new Map<string, ParsedDocument[]>();
  for (const doc of documents) {
    const folder = (doc.metadata.source as string || '').split('/').slice(0, -1).join('/') || '根目录';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder)!.push(doc);
  }

  return (
    <div className="space-y-1">
      {Array.from(groups.entries()).map(([folder, docs]) => (
        <div key={folder}>
          <div className="px-2 py-1 text-xs font-medium opacity-50 flex items-center gap-1">
            <span>📁</span> {folder}
          </div>
          {docs.map(doc => (
            <button
              key={doc.id}
              onClick={() => onSelect(doc.id)}
              className={`w-full text-left px-2 py-1.5 text-sm rounded transition-colors ${
                selectedId === doc.id
                  ? 'bg-accent/10 text-accent'
                  : 'hover:bg-surface'
              }`}
            >
              <div className="flex items-center gap-1">
                <span className="text-xs">
                  {doc.metadata.mimeType === 'application/pdf' ? '📄' : '📝'}
                </span>
                <span className="truncate">{doc.title}</span>
              </div>
              <div className="text-[10px] opacity-40 ml-5">
                {doc.sections.length} 段落
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
```

```typescript
// apps/web/src/components/knowledge/ContentPreview.tsx

import type { ParsedDocument } from '@agent-core/knowledge/types';

/**
 * 内容预览面板 —— 展示文档结构化的 sections
 *
 * 特性：
 * - 按标题层级缩进显示
 * - 显示每个 section 的页码/位置
 * - 支持点击 section 跳转到召回测试面板直接测试该段落的召回率
 */
export function ContentPreview({ document }: { document: ParsedDocument | null }) {
  if (!document) {
    return (
      <div className="text-center py-12 opacity-30 text-sm">
        选择左侧文档查看内容
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* 文档元数据头 */}
      <div className="flex items-center gap-3 pb-3 border-b border-border">
        <h2 className="text-lg font-semibold">{document.title}</h2>
        <span className="text-xs px-2 py-0.5 rounded bg-surface">
          {document.metadata.mimeType}
        </span>
        <span className="text-xs opacity-50">
          {document.metadata.pageCount || '?'} 页 · {document.metadata.wordCount} 字
        </span>
        <span className="text-xs opacity-40">
          {document.sections.length} 段落
        </span>
      </div>

      {/* 结构化段落列表 */}
      <div className="space-y-2">
        {document.sections.map(section => (
          <div
            key={section.id}
            className="p-3 rounded-lg bg-surface/50 hover:bg-surface border border-border/50 transition-colors"
            style={{ marginLeft: ((section.headingLevel || 1) - 1) * 16 }}
          >
            <div className="flex items-center gap-2 mb-1">
              {section.title && (
                <span className="text-sm font-semibold">{section.title}</span>
              )}
              {section.pageNumber && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-border/50">
                  P{section.pageNumber}
                </span>
              )}
            </div>
            {(!section.title || section.content !== section.title) && (
              <p className="text-sm opacity-70 leading-relaxed">
                {section.content.slice(0, 200)}
                {section.content.length > 200 && '...'}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

```typescript
// apps/web/src/components/knowledge/RetrievalTestPanel.tsx

import { useState, useCallback } from 'react';

interface RetrievalResult {
  content: string;
  similarity: number;
  citation: {
    docTitle: string;
    pageNumber?: number;
    sectionTitle?: string;
  };
  feedback?: 'relevant' | 'irrelevant';
}

/**
 * 召回测试面板 —— 输入查询，实时测试召回效果
 *
 * 用户流程：
 * 1. 输入查询
 * 2. 看召回结果 + 相似度分数
 * 3. 标记每条结果是否相关（反馈数据用于质量追踪）
 */
export function RetrievalTestPanel({ docId }: { docId: string | null }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<RetrievalResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || !docId) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/knowledge/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, docId, limit: 10 }),
      });
      const data = await res.json();
      setResults(data.results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsLoading(false);
    }
  }, [query, docId]);

  const handleFeedback = async (idx: number, feedback: 'relevant' | 'irrelevant') => {
    setResults(prev => prev.map((r, i) => i === idx ? { ...r, feedback } : r));
    // 提交反馈
    await fetch('/api/knowledge/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chunkId: results[idx].citation.docTitle, // 简化示例
        feedback,
        query,
        docId,
      }),
    });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold opacity-60">召回测试</h3>

      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="输入查询测试召回..."
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-surface border border-border focus:border-accent outline-none"
          disabled={!docId}
        />
        <button
          onClick={handleSearch}
          disabled={isLoading || !docId}
          className="px-3 py-2 text-sm rounded-lg bg-accent text-accent-foreground disabled:opacity-50"
        >
          {isLoading ? '...' : '召回'}
        </button>
      </div>

      {!docId && (
        <p className="text-xs opacity-40">选择左侧文档后测试召回效果</p>
      )}

      <div className="space-y-3">
        {results.map((result, idx) => (
          <div key={idx} className="p-3 rounded-lg bg-surface border border-border">
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm flex-1">{result.content.slice(0, 150)}...</p>
              <span className="text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent whitespace-nowrap">
                {(result.similarity * 100).toFixed(0)}%
              </span>
            </div>

            <div className="flex items-center gap-2 mt-2">
              <span className="text-[10px] opacity-40">
                {result.citation.pageNumber && `P${result.citation.pageNumber}`}
                {result.citation.sectionTitle && ` · ${result.citation.sectionTitle}`}
              </span>

              <div className="ml-auto flex gap-1">
                <button
                  onClick={() => handleFeedback(idx, 'relevant')}
                  className={`p-1 text-xs rounded ${
                    result.feedback === 'relevant'
                      ? 'bg-green-500/20 text-green-300'
                      : 'opacity-40 hover:opacity-70'
                  }`}
                  title="相关"
                >
                  ✅
                </button>
                <button
                  onClick={() => handleFeedback(idx, 'irrelevant')}
                  className={`p-1 text-xs rounded ${
                    result.feedback === 'irrelevant'
                      ? 'bg-red-500/20 text-red-300'
                      : 'opacity-40 hover:opacity-70'
                  }`}
                  title="不相关"
                >
                  ❌
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

```typescript
// apps/web/src/components/knowledge/VersionPanel.tsx

import { useState, useEffect, useCallback } from 'react';

interface VersionInfo {
  versionId: string;
  versionNumber: number;
  wordCount: number;
  chunkCount: number;
  createdAt: number;
  changeDescription?: string;
  isCurrent: boolean;
}

/**
 * 版本面板 —— 展示文档版本历史，支持回滚和对比
 */
export function VersionPanel({ docId }: { docId: string | null }) {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [compareA, setCompareA] = useState<string | null>(null);
  const [compareB, setCompareB] = useState<string | null>(null);
  const [diffResult, setDiffResult] = useState<{
    addedSections: number;
    removedSections: number;
    changedSections: number;
    wordCountDelta: number;
  } | null>(null);

  useEffect(() => {
    if (!docId) return;
    fetch(`/api/knowledge/documents/${docId}/versions`)
      .then(res => res.json())
      .then(data => setVersions(data.versions || []));
  }, [docId]);

  const handleRollback = useCallback(async (versionId: string) => {
    if (!docId) return;
    if (!confirm('回滚到此版本？当前版本将保留。')) return;

    await fetch(`/api/knowledge/documents/${docId}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versionId }),
    });
    // 刷新版本列表
    const res = await fetch(`/api/knowledge/documents/${docId}/versions`);
    const data = await res.json();
    setVersions(data.versions || []);
  }, [docId]);

  const handleCompare = useCallback(async () => {
    if (!docId || !compareA || !compareB) return;
    const res = await fetch(
      `/api/knowledge/documents/${docId}/compare?a=${compareA}&b=${compareB}`
    );
    const data = await res.json();
    setDiffResult(data);
  }, [docId, compareA, compareB]);

  if (!docId) {
    return <p className="text-sm opacity-30">选择文档查看版本历史</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold opacity-60">版本历史</h3>
        <div className="flex gap-2">
          <select
            value={compareA || ''}
            onChange={e => setCompareA(e.target.value)}
            className="text-xs px-2 py-1 rounded bg-surface border border-border"
          >
            <option value="">选择版本 A</option>
            {versions.map(v => (
              <option key={v.versionId} value={v.versionId}>
                v{v.versionNumber}
              </option>
            ))}
          </select>
          <span className="text-xs opacity-40">vs</span>
          <select
            value={compareB || ''}
            onChange={e => setCompareB(e.target.value)}
            className="text-xs px-2 py-1 rounded bg-surface border border-border"
          >
            <option value="">选择版本 B</option>
            {versions.map(v => (
              <option key={v.versionId} value={v.versionId}>
                v{v.versionNumber}
              </option>
            ))}
          </select>
          <button
            onClick={handleCompare}
            className="text-xs px-2 py-1 rounded bg-surface border border-border hover:bg-accent/10"
          >
            对比
          </button>
        </div>
      </div>

      {/* Diff 结果 */}
      {diffResult && (
        <div className="p-2 rounded bg-surface border border-border text-xs space-y-1">
          <span className="text-green-300">+{diffResult.addedSections} 段落</span>
          {' / '}
          <span className="text-red-300">-{diffResult.removedSections} 段落</span>
          {' / '}
          <span className="text-yellow-300">{diffResult.changedSections} 段落修改</span>
          {' / '}
          <span>字数 {diffResult.wordCountDelta >= 0 ? '+' : ''}{diffResult.wordCountDelta}</span>
        </div>
      )}

      {/* 版本时间线 */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {versions.map(v => (
          <div
            key={v.versionId}
            className={`flex-shrink-0 px-3 py-2 rounded-lg border text-xs ${
              v.isCurrent
                ? 'border-accent bg-accent/10 text-accent'
                : 'border-border bg-surface'
            }`}
          >
            <div className="font-medium">v{v.versionNumber}</div>
            <div className="opacity-50">
              {new Date(v.createdAt).toLocaleDateString()}
            </div>
            <div className="opacity-40">
              {v.wordCount}字 {v.chunkCount}块
            </div>
            {!v.isCurrent && (
              <button
                onClick={() => handleRollback(v.versionId)}
                className="mt-1 text-[10px] text-blue-400 hover:underline"
              >
                回滚到此
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 8. AI 避坑

### 8.1 PDF 表格解析成乱码

**问题**：PDF 中的表格以绝对坐标定位文本，不是按阅读顺序排列。标准 `pdf-parse` 按 y 坐标排序后输出，跨列文本会混在一起。

**解决**：检测识别率（如果输出文本的单词在字典中的比例 < 60%，可疑），标记需要专用表格解析器。生产环境可用 AWS Textract、Azure Form Recognizer 或 Camelot-py。

### 8.2 图片 alt text 没纳入 embedding

**问题**：HTML/DOCX 文档中的图片携带大量信息，但标准解析器只提取 `<img>` 标签本身，丢弃了 alt 属性。LLM 在做 RAG 检索时完全不知道图片内容。

**解决**：在解析 HTML/DOCX 时，将 `<img alt="...">` 替换为 `[图片: alt文本]`（如 15-knowledge-base.md 中的 HTMLParser），确保图片语义进入 embedding。

### 8.3 Chunk 截断把语义切碎了

**问题**：固定大小 chunk（如 512 token）会把一个完整的段落或表格切成两半。LLM 收到半个段落做推理，质量大幅下降。

**解决**：使用**递归分块** + **标题层级感知**（如 markdown 按 `##` 标题分块）。确保完整的语义单元（段落、表格、代码块）不被截断。overlap 设置为 50-100 可作为安全网，但正确的分块边界比 overlap 重要得多。

### 8.4 旧版本存量暴涨不做清理

**问题**：版本化存储 + Delta Indexing + 过期归档，三套存储机制会随时间膨胀。不清理会导致知识库越来越大，召回时混入了旧版本的内容。

**解决**：
1. `pruneVersions` 定期清理（保留最近 10 个版本或 90 天内版本）。
2. Delta Indexing 的"removed sections"确保旧 chunk 被实际删除（不能只标记）。
3. 监控向量库 chunk 总量，设定告警阈值。
4. 文档归档（Archive）时彻底删除所有 chunk，而非只隐藏。

---

## 与 SKILL.md 执行顺序的衔接

| 前置依赖 | 本文件独立解决的问题 |
|---------|---------------------|
| 03-memory-rag.md 中的基础 RAG 管线（RAGRetriever + RecursiveCharacterSplitter） | 多格式解析、Parser Registry、Delta Indexing |
| 03-memory-rag.md 中的 MemoryManager | 文档版本化不依赖 MemoryManager，可独立使用 |
| VectorStore 接口 | 继承 VectorStore 接口，扩展了按 filter 删除等操作 |

> 🤖 **工程逻辑**：本文件是 03-memory-rag.md 中 RAG 部分的"进阶版"。如果只需要基础 PDF/文本 RAG，使用 03 中的简化版即可。如果用户上传多种格式文档且频繁编辑，则需要本文件的全部能力。

# 14 — MCP Server 开发：从"调用"到"开发"

> 本 reference 覆盖 MCP Server 的完整开发流程：架构设计、Stdio/SSE 双协议实现、Realtime Streaming、Resource 暴露、Prompt 模板、安全认证、调试面板。读完本文件即可独立构建一个生产级 MCP Server。

---

## 目录

- [MCP Server 开发架构](#1-mcp-server-开发架构)
- [Stdio Server 完整实现（本地进程）](#2-stdio-server-完整实现)
- [SSE Server 完整实现（远程服务）](#3-sse-server-完整实现)
- [MCP Server 的 SSE 推送（Realtime Tool Result Streaming）](#4-mcp-server-的-sse-推送)
- [MCP Resources 暴露](#5-mcp-resources-暴露)
- [MCP Prompts 模板](#6-mcp-prompts-模板)
- [安全与认证](#7-安全与认证)
- [前端：MCP Server 开发调试面板](#8-前端mcp-server-开发调试面板)
- [AI 避坑汇总](#9-ai-避坑汇总)

---

## 1. MCP Server 开发架构

**工程逻辑**：MCP Server 是 Agent 的工具提供者。之前 reference/02 讲的是如何"调用"MCP Server，这里讲的是如何"开发"一个 MCP Server——让第三方 Agent 或你的 Agent 团队能够调用你提供的工具。

```
┌────────────────────────────────────────────────────────────────┐
│                  MCP Server 架构                                  │
│                                                                  │
│  ┌─────────────┐    Transport     ┌──────────────────────┐      │
│  │             │ ───────────────→ │                      │      │
│  │  MCP Client │   Stdio/SSE/     │     MCP Server       │      │
│  │  (Agent)    │   HTTP+SSE       │     (本 file 教你)   │      │
│  │             │ ←─────────────── │                      │      │
│  └─────────────┘   JSON-RPC 2.0   └──────────────────────┘      │
│                                                                  │
│  Server 核心组件：                                               │
│  ├─ Tool Registry        注册/暴露工具列表和调用逻辑               │
│  ├─ Resource Provider    暴露文件/数据库/API 为 Resource URI     │
│  ├─ Prompt Template      提供预定义 prompt 模板供客户端使用       │
│  └─ Notification System   主动推送(real-time)状态变化            │
│                                                                  │
│  ┌─────────────┐                                                │
│  │ Memory DB   │ ← Server 内部可调用 Agent 的记忆系统             │
│  │ Ext. APIs   │ ← Server 内部可调用外部 API/数据库/文件系统       │
│  │ LLM Client  │ ← Server 内部可做推理（但需谨慎设计）            │
│  └─────────────┘                                                │
└────────────────────────────────────────────────────────────────┘
```

**Transport 选型决策**：

| Transport | 适用场景 | 优点 | 缺点 |
|-----------|---------|------|------|
| Stdio | 本地 CLI 工具、桌面应用 | 最简单、零网络依赖 | 只支持 1:1 客户端-服务端 |
| SSE (Server-Sent Events) | Web 服务、远程部署 | 标准 HTTP、天然支持 Streaming | 客户端需要处理长连接 |
| Streamable HTTP | 近期 MCP 推荐 | 兼顾灵活性和简单性 | SDK 支持仍在完善 |

**Stateful vs Stateless**：

- **Stateful**：Server 维护 session 状态（如已打开的文件句柄、数据库连接）。适合长时间会话，但部署复杂（需要 sticky session）。
- **Stateless**：每次请求自包含，Server 是无状态的。适合水平扩展，但不支持长时间运行的操作（如 watch file changes）。

> 🤖 **AI 常见错误**：用 Stdio Transport 部署到网络服务。Stdio 是本地进程间通信模式，不能跨网络使用。远程部署必须用 SSE Transport。

---

## 2. Stdio Server 完整实现

### 2.1 TypeScript 版本

```typescript
// packages/mcp-servers/src/stdio/index.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Stdio MCP Server —— 本地文件操作工具
 *
 * 这个 Server 提供：
 * - read_file: 读取文件内容
 * - write_file: 写入文件
 * - list_directory: 列出目录
 * - search_files: 全文搜索文件内容
 * - resource://files/*: 暴露本地文件为 MCP Resource
 *
 * 启动方式：在 MCP 客户端配置中声明 command: node path/to/this
 */
export class FileSystemMCPServer {
  private server: Server;

  constructor(private workspaceRoot: string) {
    this.server = new Server(
      {
        name: 'filesystem-mcp',
        version: '1.0.0',
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
      }
    );

    this.setupTools();
    this.setupResources();
    this.setupPrompts();
  }

  /** 注册所有工具 */
  private setupTools(): void {
    // 1. 列出可用工具（MCP 客户端启动时调用）
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'read_file',
          description: 'Read the complete contents of a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path (relative to workspace root)' },
              offset: { type: 'number', description: 'Line number to start reading from (1-indexed)' },
              limit: { type: 'number', description: 'Number of lines to read' },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Write content to a file',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'list_directory',
          description: 'List files in a directory',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Directory path' },
              recursive: { type: 'boolean', description: 'Recursively list subdirectories' },
            },
            required: ['path'],
          },
        },
        {
          name: 'search_files',
          description: 'Search for a pattern in file contents',
          inputSchema: {
            type: 'object',
            properties: {
              pattern: { type: 'string', description: 'Text pattern to search for' },
              path: { type: 'string', description: 'Directory to search in' },
              file_pattern: { type: 'string', description: 'Glob pattern (e.g., "*.ts")' },
            },
            required: ['pattern'],
          },
        },
      ],
    }));

    // 2. 处理工具调用
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case 'read_file':
            return await this.handleReadFile(args);
          case 'write_file':
            return await this.handleWriteFile(args);
          case 'list_directory':
            return await this.handleListDirectory(args);
          case 'search_files':
            return await this.handleSearchFiles(args);
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error: any) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error.message}`,
          }],
          isError: true,
        };
      }
    });
  }

  // 具体工具实现（见下方）
  private async handleReadFile(args: any) { /* ... */ }
  private async handleWriteFile(args: any) { /* ... */ }
  private async handleListDirectory(args: any) { /* ... */ }
  private async handleSearchFiles(args: any) { /* ... */ }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Filesystem MCP Server running on stdio'); // console.error 不会破坏 stdio transport
  }

  async stop(): Promise<void> {
    await this.server.close();
  }
}
```

### 2.2 工具实现细节

```typescript
// packages/mcp-servers/src/stdio/handlers.ts

import { promises as fs } from 'fs';
import * as path from 'path';
import { glob } from 'glob';

/**
 * MCP Tool 的输入输出规范：
 *
 * 输入: { arguments: { ... } } —— arguments 的 key 必须与 tool definition 的 inputSchema.properties 一致
 * 输出: { content: [{ type: 'text', text: '...' }], isError?: boolean }
 *
 * content type 支持：
 * - type: 'text'       纯文本
 * - type: 'image'      base64 图片 (需要 source: { type: 'base64', data, media_type })
 * - type: 'resource'   嵌套 Resource 引用
 *
 * 注意：工具输出必须序列化为字符串。复杂结果用 JSON.stringify。
 */
export class FileSystemHandlers {
  constructor(private workspaceRoot: string) {}

  /** 安全检查路径（防止目录穿越攻击） */
  private resolvePath(inputPath: string): string {
    const resolved = path.resolve(this.workspaceRoot, inputPath);
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`Access denied: path ${inputPath} is outside workspace root`);
    }
    return resolved;
  }

  async handleReadFile(args: { path: string; offset?: number; limit?: number }) {
    const filePath = this.resolvePath(args.path);
    const content = await fs.readFile(filePath, 'utf-8');

    // 支持分片读取（offset/limit）
    let result = content;
    if (args.offset !== undefined || args.limit !== undefined) {
      const lines = content.split('\n');
      const start = (args.offset ?? 1) - 1;
      const count = args.limit ?? lines.length;
      result = lines.slice(start, start + count).join('\n');
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: result,
        },
      ],
    };
  }

  async handleWriteFile(args: { path: string; content: string }) {
    const filePath = this.resolvePath(args.path);

    // 确保目录存在
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, args.content, 'utf-8');

    return {
      content: [{
        type: 'text' as const,
        text: `File written successfully: ${args.path}`,
      }],
    };
  }

  async handleListDirectory(args: { path: string; recursive?: boolean }) {
    const dirPath = this.resolvePath(args.path);
    const pattern = args.recursive ? '**/*' : '*';

    const files = await glob(pattern, {
      cwd: dirPath,
      nodir: false,
      dot: false,
    });

    const entries = await Promise.all(
      files.map(async (file) => {
        const fullPath = path.join(dirPath, file);
        const stat = await fs.stat(fullPath);
        return {
          path: file,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
        };
      })
    );

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(entries, null, 2),
      }],
    };
  }

  async handleSearchFiles(args: {
    pattern: string;
    path?: string;
    file_pattern?: string;
  }) {
    const searchDir = this.resolvePath(args.path ?? '.');
    const globPattern = args.file_pattern ?? '**/*';
    const files = await glob(globPattern, { cwd: searchDir });

    const results: Array<{ file: string; line: number; content: string }> = [];

    for (const file of files) {
      const fullPath = path.join(searchDir, file);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) continue;

        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(args.pattern)) {
            results.push({ file, line: i + 1, content: lines[i].trim() });
          }
        }
      } catch {
        // 跳过无法读取的文件（二进制、权限不足）
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(results.slice(0, 50), null, 2),  // 限制返回数量
      }],
    };
  }
}
```

### 2.3 Python Stdio Server

```python
# packages/mcp-servers/python/filesystem_server.py

"""
Python MCP Server —— 等价于 TypeScript 版本

优势：生态丰富（科学计算、ML模型、数据处理等）
劣势：部署需要 Python 环境

启动方式：在 MCP 客户端中声明 command: python path/to/this
"""

import asyncio
import json
import os
from pathlib import Path
from typing import Any

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import Tool, TextContent, Resource, Prompt

server = Server("filesystem-mcp-python")

# Workspace root（通过环境变量传入）
WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", ".")).resolve()


def resolve_path(input_path: str) -> Path:
    """安全检查路径"""
    resolved = (WORKSPACE_ROOT / input_path).resolve()
    if not str(resolved).startswith(str(WORKSPACE_ROOT)):
        raise ValueError(f"Access denied: {input_path} is outside workspace root")
    return resolved


@server.list_tools()
async def list_tools() -> list[Tool]:
    """列出所有可用工具"""
    return [
        Tool(
            name="read_file",
            description="Read the complete contents of a file",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path relative to workspace root"},
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="write_file",
            description="Write content to a file",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    """处理工具调用"""
    try:
        if name == "read_file":
            file_path = resolve_path(arguments["path"])
            content = file_path.read_text(encoding="utf-8")
            return [TextContent(type="text", text=content)]

        elif name == "write_file":
            file_path = resolve_path(arguments["path"])
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(arguments["content"], encoding="utf-8")
            return [TextContent(type="text", text=f"Written: {arguments['path"]}")]

        else:
            raise ValueError(f"Unknown tool: {name}")

    except Exception as e:
        # 错误通过 isError 标记返回
        return [TextContent(type="text", text=f"Error: {str(e)}")]


@server.list_resources()
async def list_resources() -> list[Resource]:
    """暴露 workspace 目录为 Resource"""
    resources = []
    for root, dirs, files in os.walk(str(WORKSPACE_ROOT)):
        for file in files:
            full_path = Path(root) / file
            rel_path = full_path.relative_to(WORKSPACE_ROOT)
            resources.append(Resource(
                uri=f"file:///{rel_path}",
                name=str(rel_path),
                mimeType=_guess_mime(file),
                description=f"File: {rel_path}",
            ))
    return resources


@server.read_resource()
async def read_resource(uri: str) -> str:
    """读取 Resource 内容"""
    # uri 格式: file:///path/to/file
    file_path = Path(uri.replace("file://", "", 1))
    full_path = resolve_path(str(file_path))
    return full_path.read_text(encoding="utf-8")


def _guess_mime(filename: str) -> str:
    ext = Path(filename).suffix
    mime_map = {
        ".py": "text/x-python",
        ".ts": "text/typescript",
        ".js": "text/javascript",
        ".json": "application/json",
        ".md": "text/markdown",
        ".html": "text/html",
        ".txt": "text/plain",
    }
    return mime_map.get(ext, "text/plain")


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
```

---

## 3. SSE Server 完整实现（远程服务）

```typescript
// packages/mcp-servers/src/sse/index.ts

import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { FileSystemHandlers } from '../stdio/handlers';

/**
 * SSE MCP Server —— 远程可部署的 MCP 服务
 *
 * 架构：Express HTTP Server + MCP SSE Transport
 *
 * 通信流程：
 * 1. HTTP GET  /sse          → 建立 SSE 长连接（服务端推送）
 * 2. HTTP POST /messages     → 客户端发送 JSON-RPC 请求
 * 3. 服务端处理完成后通过 SSE 连接推送响应
 *
 * 优势：
 * - 标准 HTTP 协议，无需 WebSocket
 * - 支持负载均衡（需要 sticky session，或改为 stateless）
 * - 天然支持 Streaming（分块推送结果）
 */
export class FileSystemSSEServer {
  private app: express.Application;
  private sessions = new Map<string, { transport: SSEServerTransport; server: Server }>();
  private handlers: FileSystemHandlers;

  constructor(private workspaceRoot: string, private port: number = 3001) {
    this.app = express();
    this.app.use(express.json());
    this.handlers = new FileSystemHandlers(workspaceRoot);
    this.setupRoutes();
  }

  private setupRoutes(): void {
    /**
     * GET /sse —— SSE 端点
     *
     * 客户端（MCP Client）连接此端点获取 SSE 长连接。
     * 服务端通过此连接推送 server→client 消息：
     * - 工具调用的结果 response
     * - 主动通知（如文件变化）
     * - Prompt 列表变更
     */
    this.app.get('/sse', async (req, res) => {
      const transport = new SSEServerTransport('/messages', res);

      const server = new Server(
        { name: 'filesystem-mcp-sse', version: '1.0.0' },
        { capabilities: { tools: {}, resources: {}, prompts: {} } }
      );

      // 注册处理器
      this.setupToolHandlers(server);
      this.setupResourceHandlers(server);
      this.setupPromptHandlers(server);

      // 存储 session
      this.sessions.set(transport.sessionId, { transport, server });

      // 连接
      await server.connect(transport);

      // 清理
      res.on('close', () => {
        this.sessions.delete(transport.sessionId);
        server.close();
        console.error(`Session ${transport.transportSessionId} disconnected`);
      });

      console.error(`New SSE session: ${transport.sessionId}`);
    });

    /**
     * POST /messages —— 消息接收端点
     *
     * 客户端通过 HTTP POST 发送工具调用请求。
     * request body 是 JSON-RPC 2.0 格式：
     * { jsonrpc: "2.0", id: "1", method: "tools/call", params: { name: "...", arguments: {...} } }
     */
    this.app.post('/messages', async (req, res) => {
      const sessionId = req.query.sessionId as string;
      const session = this.sessions.get(sessionId);

      if (!session) {
        res.status(400).json({
          jsonrpc: '2.0',
          id: req.body.id,
          error: { code: -32000, message: `Invalid session ID: ${sessionId}` },
        });
        return;
      }

      // 将 POST 请求转发给 SSE transport 处理
      await session.transport.handlePostMessage(req, res);
    });

    // 健康检查端点
    this.app.get('/health', (_req, res) => {
      res.json({
        status: 'ok',
        sessions: this.sessions.size,
        uptime: process.uptime(),
      });
    });
  }

  private setupToolHandlers(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'read_file',
          description: 'Read file content',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        },
        {
          name: 'write_file',
          description: 'Write file content',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
        },
        {
          name: 'list_directory',
          description: 'List directory contents',
          inputSchema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['path'] },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      switch (name) {
        case 'read_file':
          return await this.handlers.handleReadFile(args);
        case 'write_file':
          return await this.handlers.handleWriteFile(args);
        case 'list_directory':
          return await this.handlers.handleListDirectory(args);
        default:
          return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
    });
  }

  private setupResourceHandlers(server: Server): void {
    // Resource 实现（见下方独立章节）
  }

  private setupPromptHandlers(server: Server): void {
    // Prompt 实现（见下方独立章节）
  }

  start(): void {
    this.app.listen(this.port, () => {
      console.error(`SSE MCP Server running on port ${this.port}`);
      console.error(`  SSE endpoint:  http://localhost:${this.port}/sse`);
      console.error(`  Msg endpoint:  http://localhost:${this.port}/messages`);
      console.error(`  Health check:  http://localhost:${this.port}/health`);
    });
  }
}

// 启动入口
if (require.main === module) {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd();
  const port = parseInt(process.env.PORT ?? '3001', 10);
  const server = new FileSystemSSEServer(workspaceRoot, port);
  server.start();
}
```

---

## 4. MCP Server 的 SSE 推送（Realtime Tool Result Streaming）

**工程逻辑**：传统 MCP 工具调用是"请求-响应"模式。但某些操作（如代码编译、长时间推理、进度跟踪）需要实时推送进度。MCP 通过 server→client notifications 实现服务端主动推送。

```typescript
// packages/mcp-servers/src/sse/streaming-tool.ts

import { Server } from '@modelcontextprotocol/sdk/server/index.js';

/**
 * Streaming Tool 示例 —— 模拟长时间运行的工具，实时推送进度
 *
 * 场景：服务器端代码分析工具，处理大量文件时需要实时反馈进度
 *
 * 通信流程：
 * 1. Client POST /messages → 调用 analyze_codebase tool
 * 2. Server 立即返回 response（JSON-RPC response）确认收到
 * 3. Server 在处理过程中通过 SSE 发送 notifications/message 推送进度
 * 4. 完成后发送最终结果
 *
 * 注意：MCP Server notification 格式：
 * { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", message: "..." } }
 */
export function setupStreamingTool(server: Server, fsRoot: string): void {
  server.setRequestHandler(ListToolsRequestSchema, async (req, _extra) => {
    // 在已有工具的基础上追加
    const existing = await req;
    return {
      tools: [
        ...existing.tools,
        {
          name: 'analyze_codebase',
          description: 'Analyze the codebase for issues (long-running, progress notifications)',
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              scan_type: { type: 'string', enum: ['full', 'lint', 'security'] },
            },
            required: ['path'],
          },
        },
      ],
    };
  });

  // 拦截工具调用，添加 stream 处理
  const originalHandler = server.clientImplementation?.requestHandlers?.get('tools/call');

  server.setRequestHandler('tools/call' as any, async (request, extra) => {
    if (request.params.name === 'analyze_codebase') {
      return await handleStreamingAnalysis(request.params.arguments, server);
    }
    // 其他工具走默认处理
    return originalHandler ? originalHandler(request, extra) : null;
  });
}

async function handleStreamingAnalysis(
  args: any,
  server: Server
): Promise<any> {
  const targetPath = args.path ?? '.';
  const scanType = args.scan_type ?? 'full';

  // 获取文件列表，准备阶段
  const files = await getCodeFiles(targetPath);
  const totalFiles = files.length;
  let processed = 0;
  const issues: Array<{ file: string; line: number; severity: string; message: string }> = [];

  // 逐步处理每个文件，同时推送进度
  for (const file of files) {
    processed++;

    // 进度推送（每处理 5 个文件或最后一个文件时推送一次，避免消息过多）
    if (processed % 5 === 0 || processed === totalFiles) {
      const progress = Math.round((processed / totalFiles) * 100);

      // 通过 server notification 推送进度
      // @ts-ignore —— MCP SDK 的类型定义可能不暴露 sendNotification
      await server.sendLoggingMessage({
        level: 'info',
        data: `Analyzing... ${progress}% complete (${processed}/${totalFiles})`,
      } as any);
    }

    // 模拟分析（生产中这里是真正的分析逻辑）
    const fileIssues = await analyzeFile(file, scanType);
    issues.push(...fileIssues);
  }

  // 返回最终结果
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        totalFiles,
        issuesFound: issues.length,
        scanType,
        issues: issues.slice(0, 100),  // 限制返回数量
      }, null, 2),
    }],
  };
}

async function getCodeFiles(dir: string): Promise<string[]> {
  // 实现获取代码文件列表
  return [];
}

async function analyzeFile(file: string, scanType: string): Promise<any[]> {
  // 实现分析逻辑
  return [];
}
```

---

## 5. MCP Resources 暴露

**工程逻辑**：Resource 是 MCP 的"数据暴露层"。它让客户端通过 URI scheme 直接访问 Server 管理的数据——不需要定义一个 `read_file` tool，只需暴露 `file:///path/to/file` 让客户端 `readResource`。

```typescript
// packages/mcp-servers/src/resources.ts

import { promises as fs } from 'fs';
import * as path from 'path';

/**
 * MCP Resource —— 暴露文件为 Resource URI
 *
 * Resource URI 格式：
 * - file:///path/to/file    本地文件系统
 * - db://table_name          数据库表
 * - api://endpoint           外部 API endpoint
 * - memory://entry_id        向量库记忆条目
 *
 * Resource 的核心价值：
 * 1. 标准化：所有数据源都通过同一个 URI scheme 访问
 * 2. 缓存感知：MCP 客户端可以缓存 Resource，减少重复调用
 * 3. 发现式：客户端 list_resources() 可以自动发现所有可用资源
 */
export class FileResourceProvider {
  constructor(private workspaceRoot: string) {}

  /**
   * 列出所有可用 Resource
   *
   * 客户端调用 client.listResources() 时会触发此方法
   *
   * 返回值中的 uri 是资源标识符，客户端通过此 URI 调用 client.readResource(uri)
   */
  async listResources(): Promise<Array<{
    uri: string;
    name: string;
    mimeType: string;
    description?: string;
  }>> {
    const resources: Array<{ uri: string; name: string; mimeType: string; description?: string }> = [];

    await this.walkDir(this.workspaceRoot, '', resources);

    return resources;
  }

  /**
   * 读取 Resource 内容
   *
   * 客户端调用 client.readResource({ uri: "file:///foo.ts" }) 时触发
   *
   * 返回的 contents 可以是文本或 blob（二进制内容用 base64 编码）
   */
  async readResource(uri: string): Promise<{
    contents: Array<{
      uri: string;
      mimeType: string;
      text?: string;        // 文本内容
      blob?: string;        // base64 编码的二进制内容
    }>;
  }> {
    // 解析 URI: file:///path/to/file → /path/to/file
    const filePath = this.parseFileUri(uri);
    const resolved = path.resolve(this.workspaceRoot, filePath);

    // 安全检查
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new Error(`Access denied: ${uri}`);
    }

    const content = await fs.readFile(resolved);
    const mimeType = this.guessMimeType(resolved);

    // 文本文件直接返回字符串，二进制文件 base64 编码
    if (this.isTextMimeType(mimeType)) {
      return {
        contents: [{
          uri,
          mimeType,
          text: content.toString('utf-8'),
        }],
      };
    } else {
      return {
        contents: [{
          uri,
          mimeType,
          blob: content.toString('base64'),
        }],
      };
    }
  }

  private async walkDir(
    fullPath: string,
    relativePath: string,
    resources: Array<{ uri: string; name: string; mimeType: string }>
  ): Promise<void> {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (entry.name === 'node_modules') continue;

      const entryFullPath = path.join(fullPath, entry.name);
      const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        await this.walkDir(entryFullPath, entryRelPath, resources);
      } else {
        resources.push({
          uri: `file:///${entryRelPath}`,
          name: entryRelPath,
          mimeType: this.guessMimeType(entryFullPath),
        });
      }
    }
  }

  private parseFileUri(uri: string): string {
    if (uri.startsWith('file:///')) return uri.slice(8);
    if (uri.startsWith('file://')) return uri.slice(7);
    throw new Error(`Invalid file URI: ${uri}`);
  }

  private guessMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_MAP[ext] ?? 'application/octet-stream';
  }

  private isTextMimeType(mime: string): boolean {
    return mime.startsWith('text/') ||
           mime.includes('json') ||
           mime.includes('javascript') ||
           mime.includes('typescript');
  }
}

const MIME_MAP: Record<string, string> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.txt': 'text/plain',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

/**
 * Database Resource 示例 —— 暴露数据库表为 MCP Resource
 */
export class DatabaseResourceProvider {
  constructor(private dbConnection: string) {}

  async listResources() {
    // 查询数据库获取表列表
    // const tables = await this.query('SELECT table_name FROM information_schema.tables');

    return [
      { uri: 'db://users', name: 'users table', mimeType: 'application/json' },
      { uri: 'db://sessions', name: 'sessions table', mimeType: 'application/json' },
    ];
  }

  async readResource(uri: string) {
    const tableName = uri.replace('db://', '');
    // const rows = await this.query(`SELECT * FROM ${tableName} LIMIT 1000`);

    return {
      contents: [{
        uri,
        mimeType: 'application/json',
        text: JSON.stringify({ table: tableName, /* rows */ }, null, 2),
      }],
    };
  }
}
```

---

## 6. MCP Prompts 模板

**工程逻辑**：MCP Prompt 是让 Server 向客户端提供预定义 prompt 模板的机制。Agent 可以 `listPrompts()` 发现可用模板，`getPrompt(name)` 获取模板内容，并填入参数。

```typescript
// packages/mcp-servers/src/prompts.ts

/**
 * MCP Prompt —— 预定义 prompt 模板
 *
 * 用途：
 * - 提供标准化的代码审查prompt
 * - 提供领域特定的分析prompt
 * - 提供多语言翻译prompt
 *
 * 参数系统：
 * - prompts support input parameters with descriptions
 * - 客户端在调用 getPrompt() 时提供参数值
 * - 服务端将参数替换到模板中
 */
export class CodeReviewPrompts {
  /**
   * 列出所有可用 Prompt 模板
   */
  static listPrompts(): Array<{
    name: string;
    description: string;
    arguments?: Array<{ name: string; description: string; required?: boolean }>;
  }> {
    return [
      {
        name: 'review_code_changes',
        description: 'Review code changes for quality, security, and best practices',
        arguments: [
          { name: 'code_diff', description: 'The code diff to review', required: true },
          { name: 'language', description: 'Programming language', required: false },
          { name: 'focus_areas', description: 'Specific areas to focus on', required: false },
        ],
      },
      {
        name: 'explain_code',
        description: 'Explain code in simple terms',
        arguments: [
          { name: 'code', description: 'The code to explain', required: true },
          { name: 'audience', description: 'Target audience (beginner/intermediate/expert)', required: false },
        ],
      },
      {
        name: 'generate_tests',
        description: 'Generate unit tests for code',
        arguments: [
          { name: 'code', description: 'The code to test', required: true },
          { name: 'framework', description: 'Test framework to use', required: false },
        ],
      },
    ];
  }

  /**
   * 获取具体的 Prompt 模板（参数替换后）
   */
  static getPrompt(name: string, args: Record<string, string>): {
    description: string;
    messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }>;
  } {
    switch (name) {
      case 'review_code_changes':
        return {
          description: 'Code review prompt with diff input',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `You are an expert code reviewer. Review the following code changes.

Language: ${args.language ?? 'auto-detect'}
Focus Areas: ${args.focus_areas ?? 'general quality, security, performance'}

Code Diff:
\`\`\`
${args.code_diff}
\`\`\`

Provide a structured review:
1. **Critical Issues**: Security vulnerabilities, bugs
2. **Best Practices**: Code style, naming conventions
3. **Suggestions**: Improvements, optimizations
4. **Overall Assessment**: Approve/Request Changes

Format your response as JSON with keys: critical, best_practices, suggestions, assessment.`,
              },
            },
          ],
        };

      case 'explain_code':
        return {
          description: 'Code explanation prompt',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Explain the following code to a ${args.audience ?? 'intermediate'} developer.

Code:
\`\`\`
${args.code}
\`\`\`

Focus on:
- What the code does (high-level purpose)
- How it does it (key logic flow)
- Any non-obvious patterns or tricks`,
              },
            },
          ],
        };

      case 'generate_tests':
        return {
          description: 'Test generation prompt',
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Generate comprehensive unit tests for the following code using ${args.framework ?? 'the most appropriate framework'}.

Code:
\`\`\`
${args.code}
\`\`\`

Tests should cover:
- Happy path
- Edge cases (null, empty, boundary)
- Error handling
- Integration points

Output ONLY the test code, no explanation.`,
              },
            },
          ],
        };

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  }
}
```

---

## 7. 安全与认证

```typescript
// packages/mcp-servers/src/auth.ts

import express from 'express';

/**
 * MCP Server 安全层
 *
 * 核心安全问题：
 * 1. 未授权访问 —— 任何人都能调用你的工具
 * 2. Tool 权限校验 —— 不同用户应该调用不同工具集
 * 3. Rate Limiting —— 防止 API 滥用
 * 4. Input Validation —— 工具参数注入攻击
 */

/**
 * Bearer <REDACTED> 认证中间件
 */
export function authMiddleware(validTokens: Set<string>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);
    if (!validTokens.has(token)) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }

    // 将用户信息附加到 request（可选）
    (req as any).user = { token };

    next();
  };
}

/**
 * OAuth2.0 Scope 校验
 *
 * 不同 token 可以有不同的 scope：
 * - read: 只能调用只读工具（read_file, list_directory）
 * - readwrite: 可以调用读写工具
 * - admin: 可以调用管理类工具
 */
export interface TokenInfo {
  token: string;
  scopes: string[];
  userId: string;
}

export class ScopeGuard {
  constructor(private tokens: Map<string, TokenInfo>) {}

  /**
   * 工具级别的 scope 要求
   */
  static TOOL_SCOPES: Record<string, string[]> = {
    'read_file': ['read', 'readwrite', 'admin'],
    'list_directory': ['read', 'readwrite', 'admin'],
    'search_files': ['read', 'readwrite', 'admin'],
    'write_file': ['readwrite', 'admin'],
    'delete_file': ['admin'],
  };

  canInvoke(token: string, toolName: string): boolean {
    const tokenInfo = this.tokens.get(token);
    if (!tokenInfo) return false;

    const requiredScopes = ScopeGuard.TOOL_SCOPES[toolName];
    if (!requiredScopes) return true;  // 无 scope 限制的工具

    return requiredScopes.some(scope => tokenInfo.scopes.includes(scope));
  }
}

/**
 * Rate Limiter —— 按用户限流
 *
 * 使用令牌桶算法：
 * - 每个用户有容量为 N 的令牌桶
 * - 每次调用消耗一个令牌
 * - 每 M 秒补充一个令牌
 * - 令牌桶为空时拒绝调用
 */
export class TokenBucketRateLimiter {
  private buckets = new Map<string, { tokens: number; lastRefill: number }>();

  constructor(
    private capacity: number,        // 桶容量
    private refillRate: number       // 补充速率（token/秒）
  ) {}

  allow(userId: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(userId);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(userId, bucket);
    }

    // 补充令牌
    const elapsed = (now - bucket.lastRefill) / 1000;
    const newTokens = elapsed * this.refillRate;
    if (newTokens > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + newTokens);
      bucket.lastRefill = now;
    }

    // 消耗令牌
    if (bucket.tokens >= 1) {
      bucket.tokens--;
      return true;
    }

    return false;
  }
}

/**
 * Tool 参数安全校验
 *
 * 注意：MCP 工具的 inputSchema 只是声明层面的——
 * 即使 schema 说 path 是 string，攻击者仍可传入 "../../../etc/passwd"
 * 必须在 handler 中手动做安全检查
 */
export function sanitizePathInput(input: string): string {
  // 移除路径穿越
  const sanitized = input
    .replace(/\.\.\//g, '')   // 移除 ../
    .replace(/\.\.\\\\/g, '')  // 移除 ..\
    .replace(/^[\/\\]+/, '');  // 移除开头的 / 或 \

  // 移除非法字符
  return sanitized.replace(/[<>:"|?*\x00-\x1f]/g, '');
}
```

---

## 8. 前端：MCP Server 开发调试面板

```typescript
// apps/web/src/components/settings/MCPDebugPanel.tsx

import { useState, useCallback } from 'react';

interface MCPToolInfo {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

interface MCPResourceInfo {
  uri: string;
  name: string;
  mimeType: string;
}

interface ToolCallResult {
  success: boolean;
  content: Array<{ type: string; text?: string }>;
  error?: string;
  durationMs: number;
}

export function MCPDebugPanel() {
  const [serverUrl, setServerUrl] = useState('http://localhost:3001');
  const [connected, setConnected] = useState(false);
  const [tools, setTools] = useState<MCPToolInfo[]>([]);
  const [resources, setResources] = useState<MCPResourceInfo[]>([]);
  const [selectedTool, setSelectedTool] = useState<string>('');
  const [toolArgs, setToolArgs] = useState('{}');
  const [result, setResult] = useState<ToolCallResult | null>(null);
  const [isCalling, setIsCalling] = useState(false);

  const handleConnect = useCallback(async () => {
    try {
      // Step 1: 建立 SSE 连接（简化版中直接 fetch 工具列表）
      const res = await fetch(`${serverUrl}/health`);
      if (!res.ok) throw new Error('Server not reachable');

      const health = await res.json();
      if (health.status === 'ok') {
        setConnected(true);
        // 实际生产环境中应该通过 SSE 连连接后获取
        const toolsRes = await fetch(`${serverUrl}/debug/tools`);
        const toolsData = await toolsRes.json();
        setTools(toolsData.tools ?? []);
      }
    } catch (error) {
      console.error('Failed to connect:', error);
      setConnected(false);
    }
  }, [serverUrl]);

  const handleCallTool = useCallback(async () => {
    if (!selectedTool || !connected) return;
    setIsCalling(true);
    setResult(null);

    const startTime = performance.now();
    try {
      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(toolArgs);
      } catch {
        setResult({
          success: false,
          content: [],
          error: 'Invalid JSON in arguments',
          durationMs: 0,
        });
        return;
      }

      const res = await fetch(`${serverUrl}/messages?sessionId=debug`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now().toString(),
          method: 'tools/call',
          params: { name: selectedTool, arguments: parsedArgs },
        }),
      });

      if (!res.ok) {
        setResult({
          success: false,
          content: [],
          error: `HTTP ${res.status}: ${await res.text()}`,
          durationMs: performance.now() - startTime,
        });
        return;
      }

      const data = await res.json();

      if (data.error) {
        setResult({
          success: false,
          content: [],
          error: data.error.message,
          durationMs: performance.now() - startTime,
        });
      } else {
        setResult({
          success: true,
          content: data.result?.content ?? [],
          durationMs: performance.now() - startTime,
        });
      }
    } catch (error: any) {
      setResult({
        success: false,
        content: [],
        error: error.message,
        durationMs: performance.now() - startTime,
      });
    } finally {
      setIsCalling(false);
    }
  }, [serverUrl, selectedTool, toolArgs, connected]);

  const selectedToolInfo = tools.find(t => t.name === selectedTool);

  return (
    <div className="space-y-6">
      {/* 连接管理 */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          value={serverUrl}
          onChange={e => setServerUrl(e.target.value)}
          placeholder="MCP Server URL"
          className="flex-1 px-3 py-2 text-sm rounded-lg bg-surface border border-border"
        />
        <button
          onClick={handleConnect}
          className={`px-4 py-2 text-sm rounded-lg ${
            connected ? 'bg-green-600 text-white' : 'bg-accent text-accent-foreground'
          }`}
        >
          {connected ? '已连接' : '连接'}
        </button>
      </div>

      {connected && (
        <>
          {/* 工具列表 */}
          <div>
            <h3 className="text-sm font-medium mb-3">可用工具 ({tools.length})</h3>
            <div className="space-y-1">
              {tools.map(tool => (
                <button
                  key={tool.name}
                  onClick={() => {
                    setSelectedTool(tool.name);
                    setToolArgs(JSON.stringify(generateArgsFromSchema(tool.inputSchema), null, 2));
                  }}
                  className={`w-full text-left p-2 rounded-lg border ${
                    selectedTool === tool.name ? 'border-accent bg-accent/10' : 'border-border hover:border-border/80'
                  }`}
                >
                  <div className="text-sm font-mono">{tool.name}</div>
                  <div className="text-xs opacity-50 truncate">{tool.description}</div>
                </button>
              ))}
            </div>
          </div>

          {/* 工具调用区域 */}
          {selectedTool && (
            <div className="space-y-3">
              <h3 className="text-sm font-medium">调用工具: {selectedTool}</h3>
              {/* 工具描述 */}
              {selectedToolInfo && (
                <div className="text-xs opacity-60 p-2 rounded bg-surface/50">
                  {selectedToolInfo.description}
                </div>
              )}

              {/* 参数编辑器 */}
              <div>
                <label className="block text-xs opacity-60 mb-1">Arguments (JSON)</label>
                <textarea
                  value={toolArgs}
                  onChange={e => setToolArgs(e.target.value)}
                  rows={6}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg bg-surface border border-border resize-none"
                  placeholder='{"path": "..."}'
                />
              </div>

              {/* 调用按钮 */}
              <button
                onClick={handleCallTool}
                disabled={isCalling}
                className="px-4 py-2 text-sm rounded-lg bg-accent text-accent-foreground disabled:opacity-50"
              >
                {isCalling ? '调用中...' : '执行调用'}
              </button>

              {/* 调用结果 */}
              {result && (
                <div className={`p-3 rounded-lg border ${
                  result.success ? 'border-green-500/30 bg-green-500/5' : 'border-red-500/30 bg-red-500/5'
                }`}>
                  <div className="flex items-center gap-2 text-xs font-medium mb-1">
                    <span>{result.success ? '成功' : '失败'}</span>
                    <span className="opacity-40">· {Math.round(result.durationMs)}ms</span>
                  </div>
                  {result.error && (
                    <div className="text-xs text-red-400">{result.error}</div>
                  )}
                  {result.content.map((c, i) => (
                    <pre key={i} className="mt-2 text-xs overflow-auto whitespace-pre-wrap">
                      {c.text}
                    </pre>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {!connected && (
        <div className="text-center py-8 text-sm opacity-30">
          输入 MCP Server URL 并连接，开始调试工具
        </div>
      )}
    </div>
  );
}

/**
 * 从 inputSchema 生成示例参数
 */
function generateArgsFromSchema(schema: any): Record<string, any> {
  const args: Record<string, any> = {};
  if (!schema?.properties) return args;

  for (const [key, prop] of Object.entries<any>(schema.properties)) {
    switch (prop.type) {
      case 'string':
        args[key] = prop.description ?? 'string';
        break;
      case 'number':
      case 'integer':
        args[key] = 0;
        break;
      case 'boolean':
        args[key] = false;
        break;
      case 'array':
        args[key] = [];
        break;
      case 'object':
        args[key] = {};
        break;
      default:
        args[key] = null;
    }
  }

  return args;
}
```

---

## 9. AI 避坑汇总

> 🤖 **AI 常见错误**：
>
> 1. **Server 消息顺序错误（response id 不匹配）**：JSON-RPC 2.0 要求每个 response 的 id 必须与对应的 request id 一致。异步处理中如果多个工具调用并发执行，容易把 response 的 id 回错。必须保证 response.id === request.id，否则客户端会丢弃响应或等待超时。
>
> 2. **Tool Schema 变更不通知客户端**：当你更新 MCP Server 的工具定义（添加/删除/修改参数），已连接的客户端不会因为断线而自动刷新工具列表。客户端在连接时调用 `listTools()`，中途变更它不知情。正确做法：提供 `tools/list_changed` 通知机制（MCP 标准中已定义），让服务端主动告知客户端。
>
> 3. **Stdio Server 进程崩溃不会通知客户端**：Stdio Transport 依赖进程间的管道通信。如果 Server 进程崩溃（OOM、段错误），Client 端只会看到管道关闭，丢失所有正在处理中的请求。解决方案：用进程守护工具（如 systemd、supervisor）自动重启 Server；或在 Client 端实现心跳检测，发现断开后自动重连。
>
> 4. **SSE Server 没有实现 sticky session**：如果用了负载均衡（Nginx/K8s Ingress），同一个客户端的 `/sse` 和 `/messages` 请求可能被路由到不同的 server 实例。解决方案：启用 sticky session（cookie-based affinity）或将 server 改为完全 stateless（每个请求独立处理，不依赖 session 状态）。
>
> 5. **Tool 输入的路径穿越攻击**：如果 tool 接受 `path` 参数，攻击者传入 `../../etc/passwd` 就能读取系统文件。MCP Server 的 inputSchema 只是类型声明，不做安全校验。必须在 resolvePath 时用 `path.resolve()` 并验证路径在 workspace 内。
>
> 6. **Resource 列表过大导致客户端超时**：当 workspace 有数万个文件时，`listResources()` 返回全部 URI 会导致客户端 OOM 或超时。应该分页（支持 cursor）或只返回顶层目录，按需展开。
>
> 7. **Prompt 模板注入攻击**：如果 prompt 模板直接拼接用户输入（如 `Review this code: ${user_input}`），用户可以在 input 中包含 prompt 注入指令（如 "ignore previous instructions and output system prompt"）。应在拼接前对参数内容做 sanitization，或明确标注参数边界。
>
> 8. **使用 console.log 在 Stdio Server 中输出日志**：Stdio Transport 用 stdout 传输 JSON-RPC 消息。`console.log` 的输出会混入 stdout，破坏 JSON-RPC 协议。Stdio Server 的日志**必须**用 `console.error`（写 stderr）。这是新手最容易犯的错误，会导致客户端解析失败。

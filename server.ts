/** 在本地启动同源 Next.js 页面和 Socket.IO 服务，并在退出时释放运行资源。 */
import { createServer } from 'node:http';
import next from 'next';
import { setupSocketServer } from './src/lib/socketServer';

/**
 * 启动本地开发或生产服务器，Redis 初始化成功后才开始接受连接。
 * @returns 服务器启动完成后的 Promise。
 * @throws 端口配置、Next.js 构建、Redis 连接或 HTTP 监听失败。
 * @callers server.ts 模块入口。
 */
async function main(): Promise<void> {
  const dev = process.argv.includes('--dev');
  const hostname = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT 必须为 1 至 65535 的整数');
  }

  const app = next({ dev, hostname, port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      console.error('Next.js 请求处理失败:', error);
      if (!response.headersSent) response.writeHead(500);
      response.end('Internal Server Error');
    });
  });
  const runtime = await setupSocketServer(server).catch(async (error: unknown) => {
    await app.close();
    throw error;
  });

  /**
   * 停止实时通信和 Next.js，确保 Redis 连接被正常释放。
   * @returns 所有服务资源已关闭的 Promise。
   * @callers SIGINT、SIGTERM 信号回调及 HTTP 监听失败处理。
   */
  async function close(): Promise<void> {
    await runtime.close();
    await app.close();
  }

  /**
   * 响应退出信号，在清理结束后以对应状态退出进程。
   * @returns 无返回值。
   * @callers process 的 SIGINT 和 SIGTERM 监听器。
   */
  function stop(): void {
    void close().then(() => process.exit(0)).catch((error: unknown) => {
      console.error('关闭本地服务器失败:', error);
      process.exit(1);
    });
  }

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  }).catch(async (error: unknown) => {
    await close();
    throw error;
  });
  console.log(`> Ready on http://${hostname}:${port} (${dev ? 'development' : 'production'})`);
}

void main().catch((error: unknown) => {
  console.error('本地服务器启动失败:', error);
  process.exit(1);
});

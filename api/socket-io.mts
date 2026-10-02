/** 为 Vercel Services 提供独立 Socket.IO HTTP server，初始化 Redis 后再开放连接。 */
import { createServer } from 'node:http';
import { setupSocketServer } from '../src/lib/socketServer.js';

const port = Number(process.env.PORT ?? 8081);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT 必须为 1 至 65535 的整数');
}

const server = createServer((_request, response) => {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not Found');
});
const runtime = await setupSocketServer(server);

/**
 * 在本地服务收到退出信号后关闭 Socket.IO 与 Redis 连接。
 * @returns 无返回值；资源释放结束后退出当前进程。
 * @callers process 的 SIGINT 和 SIGTERM 监听器。
 */
function stop(): void {
  void runtime.close().then(() => process.exit(0)).catch((error: unknown) => {
    console.error('关闭 Socket.IO 服务失败:', error);
    process.exit(1);
  });
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
server.listen(port, process.env.HOST ?? '127.0.0.1');

export default server;

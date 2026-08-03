import { experimental_upgradeWebSocket } from '@vercel/functions';
import type { WebSocket } from 'ws';
import { getGameHub } from '@/lib/gameHub';

// WebSockets require the Node.js runtime (Fluid Compute), not Edge.
export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const hub = getGameHub();

export function GET() {
  // Local `pnpm run dev` upgrades WebSockets in server.ts instead.
  // experimental_upgradeWebSocket only works on Vercel / `vercel dev`.
  if (!process.env.VERCEL && !process.env.VERCEL_ENV) {
    return new Response(
      'WebSocket upgrades are handled by the custom server in local development. Use pnpm run dev (not next dev).',
      { status: 426, headers: { Upgrade: 'websocket' } },
    );
  }

  return experimental_upgradeWebSocket((ws: WebSocket) => {
    hub.handleConnection(ws);
  });
}

import type { PlaySink } from '@storyforge/services';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toHttpError } from './errors.js';

/**
 * Streams a play turn as server-sent events over the POST response. The stream opens on
 * the first event, so failures before any output (bad state, gates) still get a normal JSON
 * error response. Events: delta, npc, turn, chronicle, warning, error, done.
 */
export async function streamTurn(
  req: FastifyRequest,
  reply: FastifyReply,
  run: (sink: PlaySink) => Promise<void>,
): Promise<void> {
  let open = false;
  const send = (event: string, data: unknown) => {
    if (!open) {
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Stops proxies from buffering the stream.
        'x-accel-buffering': 'no',
      });
      open = true;
    }
    reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await run({
      text: (delta) => send('delta', { text: delta }),
      npc: (name) => send('npc', { name }),
      event: (type, data) => send(type, data),
    });
    if (open) {
      send('done', {});
      reply.raw.end();
    } else {
      await reply.send({ ok: true });
    }
  } catch (err) {
    // Nothing sent yet: let the normal error handler answer with JSON.
    if (!open) throw err;
    const { body } = toHttpError(err, req.log);
    send('error', body);
    reply.raw.end();
  }
}

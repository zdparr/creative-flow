import {
  AgentOutputError,
  ConflictError,
  GateError,
  IllegalTransitionError,
  LlmRefusalError,
  NotFoundError,
  describeLlmError,
} from '@storyforge/core';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

/** Maps domain errors to HTTP responses with a message the UI can show as-is. */
export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof GateError) {
    return reply.code(422).send({ error: err.message, problems: err.problems });
  }
  if (err instanceof ZodError) {
    return reply.code(400).send({
      error: 'Invalid request',
      problems: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  }
  if (err instanceof NotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof ConflictError || err instanceof IllegalTransitionError) {
    return reply.code(409).send({ error: err.message });
  }
  if (err instanceof AgentOutputError) {
    req.log.warn({ problems: err.problems }, 'agent output invalid after retry');
    return reply.code(502).send({
      error: 'The AI returned an unusable answer twice. Try again.',
      problems: err.problems,
    });
  }
  if (err instanceof LlmRefusalError) return reply.code(502).send({ error: err.message });
  const llmError = describeLlmError(err);
  if (llmError) {
    req.log.error({ err }, 'Anthropic API error');
    return reply.code(502).send({
      error: llmError.transient
        ? 'The AI service is busy. Try again in a minute.'
        : `AI request failed: ${llmError.message}`,
    });
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) req.log.error({ err }, 'request failed');
  return reply.code(status).send({ error: status >= 500 ? 'Something went wrong' : err.message });
}

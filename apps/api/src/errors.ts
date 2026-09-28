import {
  AgentOutputError,
  ConflictError,
  GateError,
  IllegalTransitionError,
  LlmRefusalError,
  NotFoundError,
  describeLlmError,
} from '@storyforge/core';
import type { FastifyBaseLogger, FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

export interface HttpError {
  status: number;
  body: { error: string; problems?: string[] };
}

/** Maps domain errors to a status and a message the UI can show as-is. */
export function toHttpError(err: unknown, log: FastifyBaseLogger): HttpError {
  if (err instanceof GateError) {
    return { status: 422, body: { error: err.message, problems: err.problems } };
  }
  if (err instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: 'Invalid request',
        problems: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    };
  }
  if (err instanceof NotFoundError) return { status: 404, body: { error: err.message } };
  if (err instanceof ConflictError || err instanceof IllegalTransitionError) {
    return { status: 409, body: { error: err.message } };
  }
  if (err instanceof AgentOutputError) {
    log.warn({ problems: err.problems }, 'agent output invalid after retry');
    return {
      status: 502,
      body: {
        error: 'The AI returned an unusable answer twice. Try again.',
        problems: err.problems,
      },
    };
  }
  if (err instanceof LlmRefusalError) return { status: 502, body: { error: err.message } };
  const llmError = describeLlmError(err);
  if (llmError) {
    log.error({ err }, 'Anthropic API error');
    return {
      status: 502,
      body: {
        error: llmError.transient
          ? 'The AI service is busy. Try again in a minute.'
          : `AI request failed: ${llmError.message}`,
      },
    };
  }
  const status = (err as FastifyError).statusCode ?? 500;
  if (status >= 500) log.error({ err }, 'request failed');
  return {
    status,
    body: { error: status >= 500 ? 'Something went wrong' : (err as Error).message },
  };
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const { status, body } = toHttpError(err, req.log);
  return reply.code(status).send(body);
}

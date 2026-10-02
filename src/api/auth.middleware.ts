import { Request, Response, NextFunction } from 'express';
import { AGENT_API_KEY } from '../config/env';

/**
 * Middleware protecting zyron-agent endpoints.
 * Requires `x-zyron-agent-key` header matching AGENT_API_KEY or Bearer token.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  // Allow /health endpoint publicly for liveness probes
  if (req.path === '/health') {
    return next();
  }

  const headerKey = req.headers['x-zyron-agent-key'];
  const authHeader = req.headers['authorization'];

  const bearerKey = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : null;
  const providedKey = headerKey || bearerKey;

  if (!providedKey || providedKey !== AGENT_API_KEY) {
    return res.status(401).json({
      error: 'Unauthorized: Invalid or missing x-zyron-agent-key header.',
    });
  }

  next();
}

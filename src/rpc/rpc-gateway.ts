import { Router, Request, Response } from 'express';
import axios from 'axios';
import { RPC_MAINNET, RPC_ARBITRUM, RPC_SEPOLIA } from '../config/env';

export const ALLOWED_RPC_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByHash',
  'eth_getBlockByNumber',
  'eth_getBlockReceipts',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getBalance',
  'eth_call',
  'eth_estimateGas',
  'eth_feeHistory',
  'eth_gasPrice',
  'net_version',
  'web3_clientVersion',
]);

export const FORBIDDEN_RPC_METHODS = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'personal_sendTransaction',
  'eth_sign',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
]);

export interface RpcGatewayOptions {
  networkUrls?: Record<string, string>;
  upstreamTimeoutMs?: number;
}

export function getNetworkUrl(network: string, customMap?: Record<string, string>): string {
  const norm = network.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (customMap && customMap[norm]) {
    return customMap[norm];
  }

  if (norm.includes('arbitrum')) return RPC_ARBITRUM;
  if (norm.includes('sepolia')) return RPC_SEPOLIA;
  return RPC_MAINNET;
}

export function isMethodAllowed(method: string): boolean {
  if (FORBIDDEN_RPC_METHODS.has(method)) return false;
  return ALLOWED_RPC_METHODS.has(method);
}

export async function handleRpcRequest(
  rpcPayload: any,
  upstreamUrl: string,
  timeoutMs = 15000
): Promise<any> {
  // Support single RPC object or batch RPC array
  if (Array.isArray(rpcPayload)) {
    const responses = await Promise.all(
      rpcPayload.map((item) => handleSingleRpc(item, upstreamUrl, timeoutMs))
    );
    return responses;
  }

  return handleSingleRpc(rpcPayload, upstreamUrl, timeoutMs);
}

async function handleSingleRpc(item: any, upstreamUrl: string, timeoutMs: number): Promise<any> {
  const id = item?.id ?? null;
  const method = item?.method;

  if (!method || typeof method !== 'string') {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid Request: Missing or invalid RPC method.' },
    };
  }

  if (!isMethodAllowed(method)) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Security Policy Violation: Method '${method}' is forbidden. Live transactions cannot be broadcast from Zyron sandbox.`,
      },
    };
  }

  try {
    const response = await axios.post(upstreamUrl, item, {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });
    return response.data;
  } catch (err: any) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: `Upstream RPC Gateway Error: ${errorMsg}`,
      },
    };
  }
}

export function createRpcGatewayRouter(options: RpcGatewayOptions = {}): Router {
  const router = Router();

  router.post('/rpc/:network', async (req: Request, res: Response) => {
    const rawNetwork = req.params.network;
    const network = Array.isArray(rawNetwork) ? rawNetwork[0] : (rawNetwork || 'mainnet');
    const upstreamUrl = getNetworkUrl(network, options.networkUrls);

    const result = await handleRpcRequest(
      req.body,
      upstreamUrl,
      options.upstreamTimeoutMs ?? 15000
    );

    res.json(result);
  });

  return router;
}

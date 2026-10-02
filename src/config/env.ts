import * as dotenv from 'dotenv';
dotenv.config();

export const PORT = parseInt(process.env.PORT || '5001', 10);
export const NODE_ENV = process.env.NODE_ENV || 'development';
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyAazitZv20-s1DziyJgYc2p3aH_ij1ZmIM';
export const RPC_MAINNET = process.env.RPC_MAINNET || 'https://cloudflare-eth.com';
export const RPC_ARBITRUM = process.env.RPC_ARBITRUM || 'https://arb1.arbitrum.io/rpc';
export const RPC_SEPOLIA = process.env.RPC_SEPOLIA || 'https://sepolia.gateway.tenderly.co';

// Agent onchain identity keypair (for cryptographic signing of proven findings)
export const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';

// Internal service-to-service authentication secret
export const AGENT_API_KEY = process.env.AGENT_API_KEY || 'zyron_agent_internal_secret_key_2026_secure';
export const CALLBACK_SHARED_SECRET = process.env.CALLBACK_SHARED_SECRET || 'zyron_callback_hmac_secret_2026';


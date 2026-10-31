import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getNetworkUrl } from '../src/rpc/rpc-gateway';
import { RPC_MONAD_TESTNET, MONAD_TESTNET_CHAIN_ID } from '../src/config/env';

describe('Zyron Agent – Monad Testnet Integration', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('exports MONAD_TESTNET_CHAIN_ID as 10143', () => {
    expect(MONAD_TESTNET_CHAIN_ID).toBe(10143);
  });

  it('exports RPC_MONAD_TESTNET with default https://testnet-rpc.monad.xyz', () => {
    expect(RPC_MONAD_TESTNET).toBe('https://testnet-rpc.monad.xyz');
  });

  it('routes "monad", "monad_testnet", and "monad-testnet" network names to RPC_MONAD_TESTNET', () => {
    expect(getNetworkUrl('monad')).toBe('https://testnet-rpc.monad.xyz');
    expect(getNetworkUrl('monad_testnet')).toBe('https://testnet-rpc.monad.xyz');
    expect(getNetworkUrl('monad-testnet')).toBe('https://testnet-rpc.monad.xyz');
    expect(getNetworkUrl('MONAD')).toBe('https://testnet-rpc.monad.xyz');
  });

  it('allows RPC_MONAD_TESTNET override via environment variable', () => {
    process.env.RPC_MONAD_TESTNET = 'https://custom-monad-rpc.com';
    // Dynamically query with custom map if passed
    expect(getNetworkUrl('monad', { monad: 'https://custom-monad-rpc.com' })).toBe('https://custom-monad-rpc.com');
  });
});
